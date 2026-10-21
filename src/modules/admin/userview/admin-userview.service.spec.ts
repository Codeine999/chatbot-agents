import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { ChatbotService } from '../../chatbot/chatbot.service';
import type { LoadContextService } from '../../chatbot/context/load-context.service';
import type { ChatResponse } from '../../chatbot/shared/types/chat.types';
import type { UserSessionService } from '../../users/session/user-session.service';
import { AdminUserViewService } from './admin-userview.service';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';

/** Just enough Redis for SET NX/EX, EXPIRE and the compare-and-delete lock release. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
    expire: jest.fn((key: string) => Promise.resolve(store.has(key) ? 1 : 0)),
    eval: jest.fn((_script: string, _n: number, key: string, owner: string) => {
      if (store.get(key) !== owner) return Promise.resolve(0);
      store.delete(key);
      return Promise.resolve(1);
    }),
  };
}

function build(options: { aiEnabled?: boolean; reply?: ChatResponse } = {}) {
  const redis = fakeRedis();
  const prisma = {
    adminMember: {
      findUnique: jest.fn(() =>
        Promise.resolve({ aiEnabled: options.aiEnabled ?? true }),
      ),
    },
  };
  const handleTextMessage = jest.fn(() =>
    Promise.resolve(
      options.reply ?? {
        text: 'ค่าส่ง 40 บาทค่ะ',
        source: 'KNOWLEDGE' as const,
        contextPolicy: 'INCLUDE' as const,
      },
    ),
  );
  const context = {
    load: jest.fn(() => Promise.resolve([])),
    appendTurn: jest.fn(() => Promise.resolve(true)),
    clear: jest.fn(() => Promise.resolve(true)),
  };
  const sessions = {
    get: jest.fn(() => Promise.resolve(undefined)),
    clear: jest.fn(() => Promise.resolve()),
    resume: jest.fn(() => Promise.resolve()),
  };

  const service = new AdminUserViewService(
    redis as unknown as Redis,
    prisma as unknown as PrismaService,
    { handleTextMessage } as unknown as ChatbotService,
    context as unknown as LoadContextService,
    sessions as unknown as UserSessionService,
  );

  return { service, redis, handleTextMessage, context, sessions };
}

const message = (text = 'ค่าส่งเท่าไหร่') => ({
  clientRequestId: REQUEST,
  text,
});

describe('AdminUserViewService', () => {
  it('answers through the chatbot as a preview customer that has no LINE identity', async () => {
    const { service, handleTextMessage, context } = build();
    const { sessionId } = await service.createSession(ADMIN);

    const reply = await service.sendMessage(ADMIN, sessionId, message());

    expect(reply).toEqual({
      text: 'ค่าส่ง 40 บาทค่ะ',
      source: 'KNOWLEDGE',
      contextPolicy: 'INCLUDE',
    });
    const customer = `preview:${ADMIN}:${sessionId}`;
    expect(handleTextMessage).toHaveBeenCalledWith({
      userId: customer,
      text: 'ค่าส่งเท่าไหร่',
      postbackData: undefined,
      turnId: `preview:${ADMIN}:${REQUEST}`,
      recentMessages: [],
      preview: true,
    });
    const request = (handleTextMessage.mock.calls[0] as unknown[])[0];
    expect(request).not.toHaveProperty('conversationId');
    expect(request).not.toHaveProperty('lineMemberId');
    expect(context.appendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: customer, eventId: REQUEST }),
    );
  });

  it('clears preview context when the chatbot ends the topic', async () => {
    const { service, context } = build({
      reply: {
        text: 'ยกเลิกรายการแล้วครับ',
        source: 'RULE',
        contextPolicy: 'CLEAR',
      },
    });
    const { sessionId } = await service.createSession(ADMIN);

    await service.sendMessage(ADMIN, sessionId, message('ยกเลิก'));

    expect(context.clear).toHaveBeenCalledWith(`preview:${ADMIN}:${sessionId}`);
    expect(context.appendTurn).not.toHaveBeenCalled();
  });

  it('replays a retried request without calling the chatbot again', async () => {
    const { service, handleTextMessage, context } = build();
    const { sessionId } = await service.createSession(ADMIN);

    const first = await service.sendMessage(ADMIN, sessionId, message());
    const retry = await service.sendMessage(ADMIN, sessionId, message());

    expect(retry).toEqual(first);
    expect(handleTextMessage).toHaveBeenCalledTimes(1);
    expect(context.appendTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects a second message while the session is still answering', async () => {
    const { service, redis } = build();
    const { sessionId } = await service.createSession(ADMIN);
    redis.store.set(`preview:lock:${ADMIN}:${sessionId}`, 'another-request');

    await expect(
      service.sendMessage(ADMIN, sessionId, message()),
    ).rejects.toBeInstanceOf(ConflictException);
    // The rejected request can be retried once the session is free.
    expect(redis.store.has(`preview:request:${ADMIN}:${REQUEST}`)).toBe(false);
  });

  it('lets a failed turn be retried and releases the session lock', async () => {
    const { service, redis, handleTextMessage } = build();
    const { sessionId } = await service.createSession(ADMIN);
    handleTextMessage.mockRejectedValueOnce(new Error('provider down'));

    await expect(
      service.sendMessage(ADMIN, sessionId, message()),
    ).rejects.toThrow('provider down');
    expect(redis.store.has(`preview:lock:${ADMIN}:${sessionId}`)).toBe(false);

    await service.sendMessage(ADMIN, sessionId, message());
    expect(handleTextMessage).toHaveBeenCalledTimes(2);
  });

  it("does not let an admin reach another admin's session", async () => {
    const { service, handleTextMessage } = build();
    const { sessionId } = await service.createSession(OTHER_ADMIN);

    await expect(
      service.sendMessage(ADMIN, sessionId, message()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getSession(ADMIN, sessionId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(handleTextMessage).not.toHaveBeenCalled();
  });

  it('refuses admins whose AI access is disabled before anything is billed', async () => {
    const { service, handleTextMessage } = build({ aiEnabled: false });
    const { sessionId } = await service.createSession(ADMIN);

    await expect(
      service.sendMessage(ADMIN, sessionId, message()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(handleTextMessage).not.toHaveBeenCalled();
  });

  it('exposes workflow position but not workflow data', async () => {
    const { service, sessions } = build();
    const { sessionId } = await service.createSession(ADMIN);
    sessions.get.mockResolvedValueOnce({
      userId: 'x',
      flow: 'REGISTER',
      step: 'ASK_NAME',
      status: 'ACTIVE',
      data: { phoneNumber: '0812345678' },
    } as never);

    const state = await service.getSession(ADMIN, sessionId);

    expect(state.workflow).toEqual({
      flow: 'REGISTER',
      step: 'ASK_NAME',
      status: 'ACTIVE',
    });
  });

  it('deleting a session clears workflow, mute, context and the session itself', async () => {
    const { service, redis, sessions, context } = build();
    const { sessionId } = await service.createSession(ADMIN);
    const customer = `preview:${ADMIN}:${sessionId}`;

    await service.deleteSession(ADMIN, sessionId);

    expect(sessions.clear).toHaveBeenCalledWith(customer);
    expect(sessions.resume).toHaveBeenCalledWith(customer);
    expect(context.clear).toHaveBeenCalledWith(customer);
    expect(redis.store.has(`preview:session:${ADMIN}:${sessionId}`)).toBe(
      false,
    );
  });
});

import type { LineDelivery } from '../../../../generated/prisma/client';
import type { PrismaService } from '../../../../prisma/prisma.service';
import type { LoadContextService } from '../../../chatbot/context/load-context.service';
import type { TurnMetaStore } from '../../../chatbot/state/turn-meta.store';
import type { UserSessionService } from '../../../session/user-session.service';
import type { LineAdminService } from '../admin/line-admin.service';
import { LineDeliveryService } from './line-delivery.service';
import type { LineService } from './line-reply.service';

type Response = {
  text: string;
  source: string;
  contextPolicy: 'INCLUDE' | 'EXCLUDE' | 'CLEAR';
  assistantAct?: string;
  askedText?: string;
};

function build() {
  const tx = {
    lineChatHistory: { upsert: jest.fn(() => Promise.resolve({})) },
    lineConversation: { updateMany: jest.fn(() => Promise.resolve({})) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => Promise<void>) =>
      work(tx),
    ),
    lineDelivery: { update: jest.fn(() => Promise.resolve({})) },
  };
  const context = { appendTurn: jest.fn(() => Promise.resolve(true)) };
  const turnMeta = {
    markAssistant: jest.fn(() => Promise.resolve()),
    markAdmin: jest.fn(() => Promise.resolve()),
  };
  const service = new LineDeliveryService(
    prisma as unknown as PrismaService,
    {} as LineService,
    {} as LineAdminService,
    context as unknown as LoadContextService,
    {} as UserSessionService,
    turnMeta as unknown as TurnMetaStore,
  );
  const finalize = (row: Partial<LineDelivery>) =>
    (
      service as unknown as { finalize(row: LineDelivery): Promise<void> }
    ).finalize({
      id: 'd1',
      conversationId: 'c1',
      lineMemberId: 'm1',
      text: 'ครับ',
      adminMemberId: null,
      acceptedAt: new Date(),
      context: null,
      ...row,
    } as LineDelivery);

  return { finalize, context, turnMeta, prisma };
}

const withContext = (response: Response) => ({
  context: {
    conversationId: 'c1',
    response,
  } as unknown as LineDelivery['context'],
});

describe('LineDeliveryService finalize remembers what was sent', () => {
  it('records the assistant act once the reply is accepted, whatever the context policy', async () => {
    const { finalize, context, turnMeta } = build();

    await finalize(
      withContext({
        text: 'รับทราบค่ะ',
        source: 'RULE',
        contextPolicy: 'EXCLUDE',
        assistantAct: 'ACKED',
      }),
    );

    expect(turnMeta.markAssistant).toHaveBeenCalledWith(
      'c1',
      'ACKED',
      undefined,
    );
    expect(context.appendTurn).not.toHaveBeenCalled();
  });

  it('keeps the assistant question next to an ASKED act', async () => {
    const { finalize, turnMeta } = build();

    await finalize(
      withContext({
        text: 'เดินทางวันไหนคะ',
        source: 'RULE',
        contextPolicy: 'INCLUDE',
        assistantAct: 'ASKED',
        askedText: 'เดินทางวันไหนคะ',
      }),
    );

    expect(turnMeta.markAssistant).toHaveBeenCalledWith(
      'c1',
      'ASKED',
      'เดินทางวันไหนคะ',
    );
  });

  it('never records a registration turn', async () => {
    const { finalize, turnMeta } = build();

    await finalize(
      withContext({
        text: 'ชื่ออะไรคะ',
        source: 'REGISTRATION',
        contextPolicy: 'INCLUDE',
        assistantAct: 'ASKED',
        askedText: 'ชื่ออะไรคะ',
      }),
    );

    expect(turnMeta.markAssistant).not.toHaveBeenCalled();
  });

  it('records nothing for a reply that carries no act', async () => {
    const { finalize, turnMeta } = build();

    await finalize(
      withContext({
        text: 'ตาราง',
        source: 'KNOWLEDGE',
        contextPolicy: 'INCLUDE',
      }),
    );

    expect(turnMeta.markAssistant).not.toHaveBeenCalled();
  });

  it('marks the admin as the one talking when an admin message is accepted', async () => {
    const { finalize, turnMeta } = build();

    await finalize({ adminMemberId: 'a1' });

    expect(turnMeta.markAdmin).toHaveBeenCalledWith('c1');
    expect(turnMeta.markAssistant).not.toHaveBeenCalled();
  });

  it('does not mark an admin for an automatic reply', async () => {
    const { finalize, turnMeta } = build();

    await finalize({});

    expect(turnMeta.markAdmin).not.toHaveBeenCalled();
  });
});

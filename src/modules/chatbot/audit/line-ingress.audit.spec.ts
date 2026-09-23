/**
 * Audit: LINE ingress idempotency for the inbound half of a turn.
 * No live LINE call can happen here: the LINE services are jest mocks and any
 * unexpected call fails the test.
 */
import { LineWebhookService } from '../../line/line-webhook.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { LineWebhookEvent } from '../../line/dto/line';

type Recorder = {
  service: LineWebhookService;
  historyRows: Record<string, unknown>[];
  unreadIncrements: number;
};

function build(): Recorder {
  const historyRows: Record<string, unknown>[] = [];
  const recorder = { unreadIncrements: 0 };

  const tx = {
    lineConversation: {
      upsert: jest.fn(() => {
        recorder.unreadIncrements += 1;
        return Promise.resolve({ id: 'conversation-1' });
      }),
    },
    lineChatHistory: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        historyRows.push(data);
        return Promise.resolve(data);
      }),
    },
    lineMember: { update: jest.fn(() => Promise.resolve({})) },
  };

  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      Promise.resolve(callback(tx)),
    ),
    lineMember: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'member-1', lineUserId: 'U1' }),
      ),
    },
    lineChatHistory: {
      findUnique: jest.fn(
        ({ where }: { where: { lineMessageId?: string } }) => {
          const found = historyRows.find(
            (row) => row.lineMessageId === where.lineMessageId,
          );
          return Promise.resolve(
            found
              ? { conversationId: 'conversation-1', lineMemberId: 'member-1' }
              : null,
          );
        },
      ),
    },
  } as unknown as PrismaService;

  const explode = () => {
    throw new Error('no outbound LINE call is allowed in this audit');
  };

  const service = new LineWebhookService(
    prisma,
    { replyText: explode, getImageContent: explode } as never,
    { handleTextMessage: explode } as never,
    { load: jest.fn(() => Promise.resolve([])) } as never,
    { getProfile: explode } as never,
    { deliver: explode } as never,
    { isMuted: jest.fn(() => Promise.resolve(false)) } as never,
    { byPostbackData: () => null } as never,
  );

  return {
    service,
    historyRows,
    get unreadIncrements() {
      return recorder.unreadIncrements;
    },
  };
}

const textEvent = (): LineWebhookEvent =>
  ({
    type: 'message',
    webhookEventId: 'evt-text',
    timestamp: 1_700_000_000_000,
    replyToken: 'token',
    source: { type: 'user', userId: 'U1' },
    message: { type: 'text', id: 'msg-1', text: 'ค่าส่งเท่าไหร่' },
  }) as unknown as LineWebhookEvent;

const postbackEvent = (): LineWebhookEvent =>
  ({
    type: 'postback',
    webhookEventId: 'evt-postback',
    timestamp: 1_700_000_000_000,
    replyToken: 'token',
    source: { type: 'user', userId: 'U1' },
    postback: { data: 'menu=promo' },
  }) as unknown as LineWebhookEvent;

describe('Inbound persistence idempotency', () => {
  it('a redelivered text message is stored once and increments unread once', async () => {
    const harness = build();

    await harness.service.saveIncomingEvent(textEvent());
    await harness.service.saveIncomingEvent(textEvent());

    expect(harness.historyRows).toHaveLength(1);
    expect(harness.unreadIncrements).toBe(1);
  });

  it('observes a reprocessed rich menu postback duplicating history and unread count', async () => {
    const harness = build();

    await harness.service.saveIncomingEvent(postbackEvent());
    await harness.service.saveIncomingEvent(postbackEvent());

    // A postback carries no LINE message id, so the dedup read has no key to
    // match on and the second pass writes a second USER row.
    expect(harness.historyRows).toHaveLength(2);
    expect(harness.unreadIncrements).toBe(2);
  });
});

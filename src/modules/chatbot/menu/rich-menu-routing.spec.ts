import { AiIntentClassifierService } from '../ai-intent-classifier.service';
import { IntentRouterService } from '../intent-router.service';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';
import { RuleIntentService } from '../rule-intent.service';
import { RichMenuReplyCacheService } from './rich-menu-reply-cache.service';

const match = {
  key: 'promo_today',
  label: 'โปรวันนี้',
  replyText: 'วันนี้ลด 20% ครับ',
  via: 'POSTBACK' as const,
};

function build(cache: Partial<RichMenuReplyCacheService> = {}) {
  const retrieve = jest.fn().mockResolvedValue({
    route: 'LOW_CONFIDENCE',
    matchType: 'NONE',
    items: [],
    selectedItems: [],
    topScores: [],
    scoreGap: null,
  });

  const classify = jest.fn().mockResolvedValue({
    classification: 'GENERAL',
    confidence: 0.2,
  });

  const router = new IntentRouterService(
    new RuleIntentService(),
    { retrieve } as unknown as KnowledgeRetrievalService,
    {
      classifyLowConfidence: classify,
    } as unknown as AiIntentClassifierService,
    {
      byKey: () => null,
      byLabel: () => null,
      labels: () => [],
      ...cache,
    } as unknown as RichMenuReplyCacheService,
  );

  const resolve = (input: string, postbackData?: string) =>
    router.resolve({
      userId: 'u1',
      input,
      session: undefined,
      postbackData,
    });

  return { resolve, retrieve, classify };
}

describe('rich menu routing', () => {
  it('answers a tapped button from the tenant reply, with no AI or retrieval', async () => {
    const { resolve, retrieve, classify } = build({
      byKey: () => match,
    });

    const decision = await resolve('โปรวันนี้', 'menu=promo_today');

    expect(decision).toMatchObject({
      action: 'RICH_MENU_REPLY',
      intent: 'RICH_MENU_REPLY',
      confidence: 1,
      source: 'DATABASE',
      richMenuReply: { replyText: 'วันนี้ลด 20% ครับ' },
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it('routes a built-in intent button straight to its flow', async () => {
    const { resolve, retrieve } = build();

    const decision = await resolve('สมัครสมาชิก', 'intent=REGISTER');

    expect(decision).toMatchObject({
      action: 'START_REGISTER',
      intent: 'REGISTER',
      confidence: 1,
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('outranks the typed-digit rule when both could match', async () => {
    // "1" still means REGISTER when typed, but a button that says otherwise wins.
    const { resolve } = build({ byKey: () => match });

    const decision = await resolve('1', 'menu=promo_today');

    expect(decision.action).toBe('RICH_MENU_REPLY');
  });

  it('falls through to normal routing when the button reply is gone', async () => {
    // The button is still on customers' phones; answering nothing is not an option.
    const { resolve, retrieve } = build({ byKey: () => null });

    const decision = await resolve('โปรวันนี้', 'menu=promo_today');

    expect(decision.action).not.toBe('RICH_MENU_REPLY');
    expect(retrieve).toHaveBeenCalled();
  });

  it('falls through for a postback that uses neither grammar', async () => {
    const { resolve, retrieve } = build();

    await resolve('อะไรสักอย่าง', 'action=legacy-thing');

    expect(retrieve).toHaveBeenCalled();
  });

  it('answers the same way when the caption is typed instead of tapped', async () => {
    const { resolve, retrieve } = build({
      byLabel: () => ({ ...match, via: 'LABEL' as const }),
    });

    const decision = await resolve('โปรวันนี้');

    expect(decision).toMatchObject({
      action: 'RICH_MENU_REPLY',
      richMenuReply: { key: 'promo_today' },
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('still lets cancel out of a flow even while menus are configured', async () => {
    const { resolve } = build({ byLabel: () => null });

    const decision = await resolve('ยกเลิก');

    expect(decision.action).toBe('CANCEL_SESSION');
  });
});

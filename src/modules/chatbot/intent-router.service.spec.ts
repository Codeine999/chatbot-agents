import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { IntentRouterService } from './intent-router.service';
import { KnowledgeCandidateService } from './knowledge/knowledge-candidate.service';
import { RuleIntentService } from './rule-intent.service';
import { ConversationSession } from './user-session.service';
import { ChatContextMessage } from './types/chat.types';

const noMatch = {
  matched: false,
  exact: false,
  confidence: 0,
  score: 0,
  reason: 'no candidate',
};

const history: ChatContextMessage[] = [
  { role: 'user', text: 'สนใจ AI Agent', source: 'USER', createdAt: 1 },
  { role: 'assistant', text: 'AI Agent คือ...', source: 'AI', createdAt: 2 },
];

function build() {
  const ruleIntentService = {
    detect: jest.fn().mockReturnValue({
      intent: 'UNKNOWN',
      confidence: 0,
      source: 'RULE',
    }),
  } as unknown as jest.Mocked<RuleIntentService>;
  const knowledgeCandidateService = {
    detect: jest.fn().mockReturnValue(noMatch),
  } as unknown as jest.Mocked<KnowledgeCandidateService>;
  const aiIntentClassifierService = {
    analyze: jest.fn().mockResolvedValue({
      intent: 'GENERAL_QUESTION',
      confidence: 0.9,
    }),
  } as unknown as jest.Mocked<AiIntentClassifierService>;

  return {
    service: new IntentRouterService(
      ruleIntentService,
      knowledgeCandidateService,
      aiIntentClassifierService,
    ),
    ruleIntentService,
    knowledgeCandidateService,
    aiIntentClassifierService,
  };
}

const resolve = (
  ctx: ReturnType<typeof build>,
  input: string,
  session?: ConversationSession,
  recentMessages: ChatContextMessage[] = [],
) => ctx.service.resolve({ userId: 'U1', input, session, recentMessages });

describe('IntentRouterService priority order', () => {
  it('CANCEL wins over everything, including an active session', async () => {
    const ctx = build();
    ctx.ruleIntentService.detect.mockReturnValue({
      intent: 'CANCEL',
      confidence: 1,
      source: 'RULE',
    });

    const decision = await resolve(ctx, 'ยกเลิก', {
      userId: 'U1',
      flow: 'REGISTER',
      step: 'ASK_NAME',
      status: 'ACTIVE',
      data: {},
    } as ConversationSession);

    expect(decision.action).toBe('CANCEL_SESSION');
    expect(ctx.aiIntentClassifierService.analyze).not.toHaveBeenCalled();
  });

  it('an active REGISTER session continues by default', async () => {
    const ctx = build();

    const decision = await resolve(ctx, 'สมชาย', {
      userId: 'U1',
      flow: 'REGISTER',
      step: 'ASK_NAME',
      status: 'ACTIVE',
      data: {},
    } as ConversationSession);

    expect(decision).toMatchObject({
      action: 'CONTINUE_REGISTER',
      source: 'SESSION',
    });
    expect(ctx.knowledgeCandidateService.detect).not.toHaveBeenCalled();
  });

  it('a high-confidence non-register rule interrupts an active REGISTER session', async () => {
    const ctx = build();
    ctx.ruleIntentService.detect.mockReturnValue({
      intent: 'CONTACT_ADMIN',
      confidence: 0.95,
      source: 'RULE',
    });

    const decision = await resolve(ctx, 'ขอคุยกับแอดมิน', {
      userId: 'U1',
      flow: 'REGISTER',
      step: 'ASK_NAME',
      status: 'ACTIVE',
      data: {},
    } as ConversationSession);

    expect(decision).toMatchObject({
      action: 'CONTACT_ADMIN',
      source: 'SESSION',
    });
  });

  it('a rule at >= 0.9 short-circuits before the knowledge cache and the classifier', async () => {
    const ctx = build();
    ctx.ruleIntentService.detect.mockReturnValue({
      intent: 'REGISTER',
      confidence: 0.95,
      source: 'RULE',
    });

    const decision = await resolve(ctx, 'สมัครสมาชิก');

    expect(decision).toMatchObject({ action: 'START_REGISTER', source: 'RULE' });
    expect(ctx.knowledgeCandidateService.detect).not.toHaveBeenCalled();
    expect(ctx.aiIntentClassifierService.analyze).not.toHaveBeenCalled();
  });

  it('a rule at 0.89 falls through to the knowledge cache', async () => {
    const ctx = build();
    ctx.ruleIntentService.detect.mockReturnValue({
      intent: 'REGISTER',
      confidence: 0.89,
      source: 'RULE',
    });

    await resolve(ctx, 'สมัครยังไง');

    expect(ctx.knowledgeCandidateService.detect).toHaveBeenCalled();
  });
});

describe('IntentRouterService knowledge-cache gate', () => {
  it('trusts a cache match when there is no conversation history', async () => {
    const ctx = build();
    ctx.knowledgeCandidateService.detect.mockReturnValue({
      matched: true,
      exact: false,
      confidence: 0.85,
      score: 5,
      reason: 'matched pricing',
    });

    const decision = await resolve(ctx, 'ราคาเท่าไหร่');

    expect(decision).toMatchObject({
      action: 'ANSWER_KNOWLEDGE',
      source: 'CACHE',
      confidence: 0.85,
    });
    expect(ctx.aiIntentClassifierService.analyze).not.toHaveBeenCalled();
  });

  it('trusts an exact cache match even mid-conversation', async () => {
    const ctx = build();
    ctx.knowledgeCandidateService.detect.mockReturnValue({
      matched: true,
      exact: true,
      confidence: 0.9,
      score: 5,
      reason: 'exact example',
    });

    const decision = await resolve(ctx, 'ราคาเท่าไหร่', undefined, history);

    expect(decision.source).toBe('CACHE');
  });

  it('defers a non-exact cache match to the classifier mid-conversation so references resolve', async () => {
    const ctx = build();
    ctx.knowledgeCandidateService.detect.mockReturnValue({
      matched: true,
      exact: false,
      confidence: 0.8,
      score: 3,
      reason: 'partial',
    });
    ctx.aiIntentClassifierService.analyze.mockResolvedValue({
      intent: 'ANSWER_KNOWLEDGE',
      confidence: 0.9,
      standaloneQuery: 'ราคาของ AI Agent เท่าไหร่',
    });

    const decision = await resolve(ctx, 'แล้วราคาล่ะ', undefined, history);

    expect(decision.source).toBe('AI');
    expect(decision.resolvedQuery).toBe('ราคาของ AI Agent เท่าไหร่');
  });
});

describe('IntentRouterService AI path', () => {
  it('passes history to the classifier', async () => {
    const ctx = build();

    await resolve(ctx, 'แล้วราคาล่ะ', undefined, history);

    expect(ctx.aiIntentClassifierService.analyze).toHaveBeenCalledWith(
      'แล้วราคาล่ะ',
      { userId: 'U1', recentMessages: history },
    );
  });

  it('returns FALLBACK below the 0.6 confidence threshold', async () => {
    const ctx = build();
    ctx.aiIntentClassifierService.analyze.mockResolvedValue({
      intent: 'ANSWER_KNOWLEDGE',
      confidence: 0.59,
    });

    const decision = await resolve(ctx, 'งงอะ');

    expect(decision).toMatchObject({ action: 'FALLBACK', intent: 'UNKNOWN' });
  });

  it('forwards the rewritten standalone query for retrieval', async () => {
    const ctx = build();
    ctx.aiIntentClassifierService.analyze.mockResolvedValue({
      intent: 'ANSWER_KNOWLEDGE',
      confidence: 0.9,
      standaloneQuery: '  ราคาของ AI Agent  ',
    });

    const decision = await resolve(ctx, 'แล้วราคาล่ะ', undefined, history);

    expect(decision.resolvedQuery).toBe('ราคาของ AI Agent');
  });

  it('degrades a classifier FALLBACK to the weak cache match instead of the canned reply', async () => {
    const ctx = build();
    ctx.knowledgeCandidateService.detect.mockReturnValue({
      matched: true,
      exact: false,
      confidence: 0.7,
      score: 3,
      reason: 'partial pricing match',
    });
    ctx.aiIntentClassifierService.analyze.mockResolvedValue({
      intent: 'UNKNOWN',
      confidence: 0,
    });

    const decision = await resolve(ctx, 'ราคาไง', undefined, history);

    expect(decision).toMatchObject({
      action: 'ANSWER_KNOWLEDGE',
      source: 'CACHE',
    });
    expect(decision.reason).toContain('degraded');
  });

  it('keeps FALLBACK when there is no cache match to degrade to', async () => {
    const ctx = build();
    ctx.aiIntentClassifierService.analyze.mockResolvedValue({
      intent: 'UNKNOWN',
      confidence: 0,
    });

    const decision = await resolve(ctx, 'zzzzz');

    expect(decision.action).toBe('FALLBACK');
  });

  /**
   * DEFECT: the degraded path drops resolvedQuery, so when the classifier is
   * over budget the follow-up "แล้วราคาล่ะ" reaches answerKnowledge as raw
   * text with no antecedent - exactly the case the rewrite exists to fix.
   */
  it('DEFECT: the degraded decision discards the resolved standalone query', async () => {
    const ctx = build();
    ctx.knowledgeCandidateService.detect.mockReturnValue({
      matched: true,
      exact: false,
      confidence: 0.7,
      score: 3,
      reason: 'partial',
    });
    ctx.aiIntentClassifierService.analyze.mockResolvedValue({
      intent: 'UNKNOWN',
      confidence: 0,
      standaloneQuery: 'ราคาของ AI Agent เท่าไหร่',
    });

    const decision = await resolve(ctx, 'แล้วราคาล่ะ', undefined, history);

    expect(decision.action).toBe('ANSWER_KNOWLEDGE');
    expect(decision.resolvedQuery).toBeUndefined();
  });
});

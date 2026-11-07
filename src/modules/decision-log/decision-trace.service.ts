import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type {
  KnowledgeRetrievalResult,
  RouteDecision,
} from '../chatbot/shared/types/chat.types';
import type {
  DecisionAnswerOutcome,
  DecisionStage,
  DecisionTraceMeta,
  DecisionTraceState,
} from './types/decision-log.types';
import { sanitizeTraceData } from './utils/decision-log.sanitize';

/** A turn that loops (repairs, retries) must not grow its log without bound. */
const MAX_NOTES = 60;

export type DecisionLlmCall = Readonly<{
  provider: string;
  model: string;
  latencyMs: number;
  status: 'success' | 'failed';
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  errorName?: string;
}>;

/**
 * Collects what each stage decided for the current customer turn. The state
 * lives in AsyncLocalStorage, so stages record without threading a context
 * through every signature. Outside a turn (admin chat, tests, workers) every
 * call is a no-op. Recording never throws and never does I/O.
 */
@Injectable()
export class DecisionTraceService {
  private readonly storage = new AsyncLocalStorage<DecisionTraceState>();

  run<T>(meta: DecisionTraceMeta, work: () => Promise<T>): Promise<T> {
    return this.storage.run(
      {
        meta,
        startedAt: Date.now(),
        notes: [],
        handoffRequested: false,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      },
      work,
    );
  }

  /** The current turn's state, for persistence at the end of the turn. */
  current(): DecisionTraceState | undefined {
    return this.storage.getStore();
  }

  /** The reply exists; later work is persistence and delivery. */
  replied(): void {
    const state = this.storage.getStore();
    if (state) state.repliedAt = Date.now();
  }

  /** Marks the stage now running, so its LLM calls are labelled correctly. */
  enter(stage: DecisionStage): void {
    const state = this.storage.getStore();
    if (state) state.stage = stage;
  }

  note(stage: DecisionStage, data: Record<string, unknown>): void {
    const state = this.storage.getStore();
    if (!state) return;
    state.stage = stage;
    if (state.notes.length >= MAX_NOTES) return;
    state.notes.push({
      stage,
      atMs: Date.now() - state.startedAt,
      data: sanitizeTraceData(data),
    });
  }

  /** The router's final decision; retrieval is kept for candidate scores. */
  route(decision: RouteDecision): void {
    const state = this.storage.getStore();
    if (!state) return;
    state.route = decision;
    if (decision.retrieval) state.retrieval = decision.retrieval;
  }

  retrieval(result: KnowledgeRetrievalResult): void {
    const state = this.storage.getStore();
    if (state) state.retrieval = result;
  }

  answer(outcome: DecisionAnswerOutcome): void {
    const state = this.storage.getStore();
    if (!state) return;
    state.answer = outcome;
    this.note('answer', { ...outcome });
  }

  handoff(reason: string): void {
    const state = this.storage.getStore();
    if (!state) return;
    state.handoffRequested = true;
    this.note('handoff', { reason });
  }

  llmCall(call: DecisionLlmCall): void {
    const state = this.storage.getStore();
    if (!state) return;
    const inputTokens =
      (call.inputTokens ?? 0) +
      (call.cachedInputTokens ?? 0) +
      (call.cacheWriteTokens ?? 0);
    state.llm.calls += 1;
    state.llm.inputTokens += inputTokens;
    state.llm.outputTokens += call.outputTokens ?? 0;
    // Labelled with the stage that was running, so a log shows which step paid.
    const during = state.stage;
    if (state.notes.length >= MAX_NOTES) return;
    state.notes.push({
      stage: 'llm',
      atMs: Date.now() - state.startedAt,
      data: sanitizeTraceData({ ...call, during, promptTokens: inputTokens }),
    });
  }
}

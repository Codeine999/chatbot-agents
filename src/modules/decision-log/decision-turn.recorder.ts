import { Injectable, Optional } from '@nestjs/common';
import type { ChatResponse } from '../chatbot/shared/types/chat.types';
import type {
  ChatTurn,
  ConversationThread,
} from '../events/message/contracts/channel-adapter';
import { DecisionLogService } from './decision-log.service';
import { DecisionTraceService } from './decision-trace.service';
import type { DecisionTraceMeta } from './types/decision-log.types';

/** What the turn's work reports back: the reply it produced, if any. */
export type TurnOutcome = { response?: ChatResponse };

/**
 * The single entry point for recording a customer turn. A caller wraps the
 * turn in `record` and reports the reply with `replied`; trace and log-row
 * details stay in this file.
 */
@Injectable()
export class DecisionTurnRecorder {
  constructor(
    @Optional() private readonly trace?: DecisionTraceService,
    @Optional() private readonly logs?: DecisionLogService,
  ) {}

  /**
   * Runs the turn's work inside a trace and writes one row when it ends, even
   * if delivery failed. A turn that cannot be traced runs the work as is.
   */
  async record(
    turn: ChatTurn,
    thread: ConversationThread,
    work: (outcome: TurnOutcome) => Promise<void>,
  ): Promise<void> {
    const trace = this.trace;
    const meta = trace ? turnMeta(turn, thread) : undefined;
    if (!trace || !meta) return work({});

    await trace.run(meta, async () => {
      const outcome: TurnOutcome = {};
      let failure: unknown;
      try {
        await work(outcome);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        await this.logs?.save(trace.current(), {
          response: outcome.response,
          status: failure ? 'ERROR' : 'COMPLETED',
          errorCode: failure instanceof Error ? failure.name : undefined,
        });
      }
    });
  }

  /** The reply exists; what follows is persistence and delivery. */
  replied(outcome: TurnOutcome, response: ChatResponse): void {
    outcome.response = response;
    this.trace?.replied();
  }
}

/** Only chatbot turns with a channel event id are logged; prebuilt replies decide nothing. */
function turnMeta(
  turn: ChatTurn,
  thread: ConversationThread,
): DecisionTraceMeta | undefined {
  if (turn.kind === 'response') return undefined;
  const { request } = turn;
  if (!request.turnId) return undefined;
  return {
    channel:
      'channel' in request && request.channel === 'APP'
        ? 'APPLICATION'
        : 'LINE',
    eventId: request.turnId,
    userId: request.userId,
    conversationId: request.conversationId ?? thread.conversationId,
    messageType: turn.kind,
    input: turn.kind === 'image' ? undefined : turn.request.text,
  };
}

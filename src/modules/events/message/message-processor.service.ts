import { Injectable, Optional } from '@nestjs/common';
import { ChatbotService } from '../../chatbot/chatbot.service';
import { LoadContextService } from '../../chatbot/context/load-context.service';
import type {
  ChatContextMessage,
  ChatResponse,
} from '../../chatbot/shared/types/chat.types';
import type {
  ChannelAdapter,
  ChatTurn,
  ConversationThread,
} from './contracts/channel-adapter';
import { DecisionTraceService } from '../../decision-log/decision-trace.service';
import { DecisionLogService } from '../../decision-log/decision-log.service';
import type { DecisionTraceMeta } from '../../decision-log/types/decision-log.types';

@Injectable()
export class MessageProcessorService {
  constructor(
    private readonly chatbot: ChatbotService,
    private readonly context: LoadContextService,
    @Optional() private readonly decisionTrace?: DecisionTraceService,
    @Optional() private readonly decisionLogs?: DecisionLogService,
  ) {}

  async process<TEvent, TThread extends ConversationThread>(
    event: TEvent,
    adapter: ChannelAdapter<TEvent, TThread>,
    claimOwner?: string,
  ): Promise<void> {
    // A retry after response persistence must not call/bill the model again.
    const existing = await adapter.findDelivery(event);
    if (existing) {
      await adapter.deliver(existing.id);
      return;
    }

    const thread = await adapter.saveIncomingEvent(event);
    if (!thread) return;

    // A typing indicator must never delay or fail the turn.
    void adapter.indicateProcessing?.(event).catch(() => undefined);

    const recentMessages = await this.context.load(thread.conversationId);
    const turn = await adapter.toChatTurn(event, thread);
    if (!turn) return;

    const trace = this.decisionTrace;
    const meta = trace ? traceMeta(turn, thread) : undefined;
    if (!trace || !meta) {
      await this.answer(
        event,
        adapter,
        thread,
        turn,
        recentMessages,
        {},
        claimOwner,
      );
      return;
    }
    // One decision log row per turn, written even when delivery fails.
    await trace.run(meta, async () => {
      const outcome: { response?: ChatResponse } = {};
      let failure: unknown;
      try {
        await this.answer(
          event,
          adapter,
          thread,
          turn,
          recentMessages,
          outcome,
          claimOwner,
        );
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        await this.decisionLogs?.save(trace.current(), {
          response: outcome.response,
          status: failure ? 'ERROR' : 'COMPLETED',
          errorCode: failure instanceof Error ? failure.name : undefined,
        });
      }
    });
  }

  private async answer<TEvent, TThread extends ConversationThread>(
    event: TEvent,
    adapter: ChannelAdapter<TEvent, TThread>,
    thread: TThread,
    turn: ChatTurn,
    recentMessages: readonly ChatContextMessage[],
    outcome: { response?: ChatResponse },
    claimOwner?: string,
  ): Promise<void> {
    const response = await this.respond(turn, recentMessages);
    this.decisionTrace?.replied();
    outcome.response = response;
    if (response.contextPolicy === 'CLEAR') {
      await this.context.clear(thread.conversationId);
    }

    const delivery = await adapter.saveReply(
      event,
      thread,
      turn,
      response,
      claimOwner,
    );
    if (delivery) await adapter.deliver(delivery.id);
    // INCLUDE is appended by delivery finalization only after acceptance.
  }

  private respond(
    turn: ChatTurn,
    recentMessages: readonly ChatContextMessage[],
  ): Promise<ChatResponse> {
    switch (turn.kind) {
      case 'text':
        return this.chatbot.handleTextMessage({
          ...turn.request,
          recentMessages,
        });
      case 'image':
        return this.chatbot.handleImageMessage({
          ...turn.request,
          recentMessages,
        });
      case 'sticker':
        return this.chatbot.handleStickerMessage({
          ...turn.request,
          recentMessages,
        });
      case 'response':
        return Promise.resolve(turn.response);
    }
  }
}

/** Only chatbot turns with a channel event id are logged; prebuilt replies decide nothing. */
function traceMeta(
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

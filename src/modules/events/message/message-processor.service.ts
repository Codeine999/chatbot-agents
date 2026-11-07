import { Injectable } from '@nestjs/common';
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
import {
  DecisionTurnRecorder,
  type TurnOutcome,
} from '../../decision-log/decision-turn.recorder';

@Injectable()
export class MessageProcessorService {
  constructor(
    private readonly chatbot: ChatbotService,
    private readonly context: LoadContextService,
    private readonly turns: DecisionTurnRecorder,
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

    await this.turns.record(turn, thread, (outcome) =>
      this.answer(
        event,
        adapter,
        thread,
        turn,
        recentMessages,
        outcome,
        claimOwner,
      ),
    );
  }

  private async answer<TEvent, TThread extends ConversationThread>(
    event: TEvent,
    adapter: ChannelAdapter<TEvent, TThread>,
    thread: TThread,
    turn: ChatTurn,
    recentMessages: readonly ChatContextMessage[],
    outcome: TurnOutcome,
    claimOwner?: string,
  ): Promise<void> {
    const response = await this.respond(turn, recentMessages);
    this.turns.replied(outcome, response);
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

import { Injectable } from '@nestjs/common';
import { ChatbotService } from '../../chatbot/chatbot.service';
import { LoadContextService } from '../../chatbot/context/load-context.service';
import type {
  ChatContextMessage,
  ChatResponse,
} from '../../chatbot/types/chat.types';
import type {
  ChannelAdapter,
  ChatTurn,
  ConversationThread,
} from './contracts/channel-adapter';

@Injectable()
export class MessageProcessorService {
  constructor(
    private readonly chatbot: ChatbotService,
    private readonly context: LoadContextService,
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

    const recentMessages = await this.context.load(thread.conversationId);
    const turn = await adapter.toChatTurn(event, thread);
    if (!turn) return;

    const response = await this.respond(turn, recentMessages);
    if (response.contextPolicy === 'CLEAR') {
      await this.context.clear(thread.conversationId);
    }

    // The adapter atomically checks claim ownership and persists the reply.
    // Empty replies still pass through that check (e.g. admin mute).
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

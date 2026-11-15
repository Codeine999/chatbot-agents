import { LineChatMessageType, Prisma } from '../../../generated/prisma/client';
import type {
  LineMessageEvent,
  LinePostbackEvent,
  LineWebhookEvent,
} from './dto/line';

/** A LINE webhook event reduced to what is stored as the customer's message. */
export type IncomingLineChatMessage = {
  messageType: LineChatMessageType;
  lastMessage: string;
  text?: string;
  lineMessageId?: string;
  replyToken?: string;
  stickerPackageId?: string;
  stickerId?: string;
  stickerResourceType?: string;
  mediaUrl?: string | null;
  postbackData?: string;
};

export function toChatMessage(
  event: LineWebhookEvent,
): IncomingLineChatMessage | null {
  if (event.type === 'message') {
    return toMessageEventChatMessage(event);
  }

  if (event.type === 'postback') {
    return toPostbackEventChatMessage(event);
  }

  return null;
}

function toMessageEventChatMessage(
  event: LineMessageEvent,
): IncomingLineChatMessage | null {
  const { message } = event;

  if (message.type === 'text') {
    return {
      messageType: LineChatMessageType.TEXT,
      lastMessage: message.text,
      text: message.text,
      lineMessageId: message.id,
      replyToken: event.replyToken,
    };
  }

  if (message.type === 'image') {
    return {
      messageType: LineChatMessageType.IMAGE,
      lastMessage: '[image]',
      lineMessageId: message.id,
      replyToken: event.replyToken,
      mediaUrl: null,
    };
  }

  if (message.type === 'sticker') {
    const stickerText = message.text?.trim();

    return {
      messageType: LineChatMessageType.STICKER,
      lastMessage: stickerText || '[sticker]',
      text: stickerText || undefined,
      lineMessageId: message.id,
      replyToken: event.replyToken,
      stickerPackageId: message.packageId,
      stickerId: message.stickerId,
      stickerResourceType: message.stickerResourceType,
    };
  }

  return null;
}

function toPostbackEventChatMessage(
  event: LinePostbackEvent,
): IncomingLineChatMessage {
  return {
    messageType: LineChatMessageType.POSTBACK,
    lastMessage: event.postback.data,
    replyToken: event.replyToken,
    postbackData: event.postback.data,
  };
}

export function isUniqueConstraint(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code !== 'P2002') return false;

  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes(field) : target === field;
}

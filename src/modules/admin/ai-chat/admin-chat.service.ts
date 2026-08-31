import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AdminChatRole } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminAiProviderService } from '../../ai/admin-ai-provider.service';
import type {
  AiGenerateResponse,
  AiProviderMessage,
} from '../../../ai-provider/types/ai-provider.types';

/** Turns kept as context for the next AI call (most recent first, then re-ordered). */
const CONTEXT_MESSAGE_LIMIT = 20;
const ROOM_TITLE_MAX_LENGTH = 60;
const DEFAULT_ROOM_TITLE = 'New chat';

const ADMIN_CHAT_SYSTEM_INSTRUCTION =
  'You are an internal assistant for back-office admin staff. ' +
  'Answer clearly and concisely. You are talking to staff, not customers, ' +
  'so you may discuss internal operations — but never invent customer ' +
  'records, payment status, or account state that you were not given.';

@Injectable()
export class AdminChatService {
  private readonly logger = new Logger(AdminChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminAiProviderService: AdminAiProviderService,
  ) {}

  async listRooms(adminMemberId: string) {
    return this.prisma.adminChatRoom.findMany({
      where: { adminMemberId },
      orderBy: { lastMessageAt: 'desc' },
      select: {
        id: true,
        title: true,
        lastMessageAt: true,
        createdAt: true,
      },
    });
  }

  async listAllRooms() {
    return this.prisma.adminChatRoom.findMany({
      orderBy: { lastMessageAt: 'desc' },
      select: {
        id: true,
        title: true,
        lastMessageAt: true,
        createdAt: true,
        adminMember: {
          select: {
            id: true,
            username: true,
            firstname: true,
            lastname: true,
            role: true,
          },
        },
        _count: { select: { messages: true } },
      },
    });
  }

  async createRoom(adminMemberId: string, title?: string) {
    return this.prisma.adminChatRoom.create({
      data: {
        adminMemberId,
        title: this.normalizeTitle(title) ?? DEFAULT_ROOM_TITLE,
      },
      select: {
        id: true,
        title: true,
        lastMessageAt: true,
        createdAt: true,
      },
    });
  }

  async renameRoom(adminMemberId: string, roomId: string, title: string) {
    await this.assertRoomOwner(adminMemberId, roomId);

    return this.prisma.adminChatRoom.update({
      where: { id: roomId },
      data: { title: this.normalizeTitle(title) ?? DEFAULT_ROOM_TITLE },
      select: {
        id: true,
        title: true,
        lastMessageAt: true,
        createdAt: true,
      },
    });
  }

  async deleteRoom(adminMemberId: string, roomId: string): Promise<void> {
    await this.assertRoomOwner(adminMemberId, roomId);
    await this.prisma.adminChatRoom.delete({ where: { id: roomId } });
  }

  async listMessages(adminMemberId: string, roomId: string) {
    await this.assertRoomOwner(adminMemberId, roomId);

    return this.findMessages(roomId);
  }

  async listAllMessages(roomId: string) {
    const room = await this.prisma.adminChatRoom.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        title: true,
        lastMessageAt: true,
        createdAt: true,
        adminMember: {
          select: {
            id: true,
            username: true,
            firstname: true,
            lastname: true,
            role: true,
          },
        },
      },
    });

    if (!room) {
      throw new NotFoundException('Chat room not found');
    }

    return {
      room,
      data: await this.findMessages(roomId),
    };
  }

  private findMessages(roomId: string) {
    return this.prisma.adminChatMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        provider: true,
        model: true,
        createdAt: true,
      },
    });
  }

  async sendMessage(
    adminMemberId: string,
    input: { roomId?: string; text: string },
  ) {
    const text = input.text.trim();

    const room = input.roomId
      ? await this.assertRoomOwner(adminMemberId, input.roomId)
      : await this.prisma.adminChatRoom.create({
          data: { adminMemberId, title: this.deriveTitle(text) },
        });

    const now = new Date();
    const [userMessage] = await this.prisma.$transaction([
      this.prisma.adminChatMessage.create({
        data: {
          roomId: room.id,
          role: AdminChatRole.USER,
          content: text,
          createdAt: now,
        },
        select: {
          id: true,
          role: true,
          content: true,
          provider: true,
          model: true,
          createdAt: true,
        },
      }),
      this.prisma.adminChatRoom.update({
        where: { id: room.id },
        data: { lastMessageAt: now },
      }),
    ]);

    const history = await this.loadContext(room.id);

    let reply: AiGenerateResponse;
    try {
      reply = await this.adminAiProviderService.generate(
        adminMemberId,
        {
          systemInstruction: ADMIN_CHAT_SYSTEM_INSTRUCTION,
          messages: history,
        },
        { idempotencyKey: `admin-chat:${userMessage.id}` },
      );
    } catch (error) {
      this.logger.warn(
        `Admin AI reply failed room=${room.id}: ${String(error)}`,
      );
      throw error;
    }

    const generatedAt = new Date();
    const assistantCreatedAt =
      generatedAt.getTime() > now.getTime()
        ? generatedAt
        : new Date(now.getTime() + 1);

    const [assistantMessage] = await this.prisma.$transaction([
      this.prisma.adminChatMessage.create({
        data: {
          roomId: room.id,
          role: AdminChatRole.ASSISTANT,
          content: reply.text,
          provider: reply.provider,
          model: reply.model,
          createdAt: assistantCreatedAt,
        },
        select: {
          id: true,
          role: true,
          content: true,
          provider: true,
          model: true,
          createdAt: true,
        },
      }),
      this.prisma.adminChatRoom.update({
        where: { id: room.id },
        data: { lastMessageAt: assistantCreatedAt },
      }),
    ]);

    return {
      roomId: room.id,
      roomTitle: room.title,
      userMessage,
      reply: assistantMessage,
    };
  }

  private async loadContext(roomId: string): Promise<AiProviderMessage[]> {
    const recent = await this.prisma.adminChatMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take: CONTEXT_MESSAGE_LIMIT,
      select: { role: true, content: true },
    });

    return recent.reverse().map((message) => ({
      role: message.role === AdminChatRole.USER ? 'user' : 'assistant',
      text: message.content,
    }));
  }

  private async assertRoomOwner(adminMemberId: string, roomId: string) {
    const room = await this.prisma.adminChatRoom.findFirst({
      where: { id: roomId, adminMemberId },
    });

    if (!room) {
      throw new NotFoundException('Chat room not found');
    }

    return room;
  }

  private deriveTitle(text: string): string {
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    if (!firstLine) return DEFAULT_ROOM_TITLE;

    return firstLine.length > ROOM_TITLE_MAX_LENGTH
      ? `${firstLine.slice(0, ROOM_TITLE_MAX_LENGTH - 1)}…`
      : firstLine;
  }

  private normalizeTitle(title?: string): string | undefined {
    const trimmed = title?.trim();
    if (!trimmed) return undefined;

    return trimmed.length > ROOM_TITLE_MAX_LENGTH
      ? `${trimmed.slice(0, ROOM_TITLE_MAX_LENGTH - 1)}…`
      : trimmed;
  }
}

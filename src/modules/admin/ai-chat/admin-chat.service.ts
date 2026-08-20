import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AdminChatRole } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminAiProviderService } from '../../ai/admin-ai-provider.service';
import type { AiProviderMessage } from '../../../ai-provider/types/ai-provider.types';
import { AdminAiUsageService } from './admin-ai-usage.service';

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
    private readonly usageService: AdminAiUsageService,
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
    // Messages cascade with the room.
    await this.prisma.adminChatRoom.delete({ where: { id: roomId } });
  }

  async listMessages(adminMemberId: string, roomId: string) {
    await this.assertRoomOwner(adminMemberId, roomId);

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

  /**
   * Runs one admin chat turn: persists the admin's message, answers it with
   * the shared ADMIN-scope provider, then persists the reply. The room is
   * created on the fly when `roomId` is omitted so the UI can send from a
   * blank screen without a separate call.
   */
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

    const history = await this.loadContext(room.id);

    await this.usageService.reserveAdminAiCredit();

    let reply: Awaited<
      ReturnType<AdminAiProviderService['generate']>
    >;

    try {
      reply = await this.adminAiProviderService.generate(adminMemberId, {
        systemInstruction: ADMIN_CHAT_SYSTEM_INSTRUCTION,
        messages: [...history, { role: 'user', text }],
      });
    } catch (error) {
      // The pool was charged before the call; give it back so a provider
      // outage does not silently burn the org's admin-AI credit.
      await this.usageService.refundAdminAiCredit();
      throw error;
    }

    await this.usageService.recordUsage(adminMemberId);

    const now = new Date();

    const [, assistantMessage] = await this.prisma.$transaction([
      this.prisma.adminChatMessage.create({
        data: {
          roomId: room.id,
          role: AdminChatRole.USER,
          content: text,
          createdAt: now,
        },
      }),
      this.prisma.adminChatMessage.create({
        data: {
          roomId: room.id,
          role: AdminChatRole.ASSISTANT,
          content: reply.text,
          provider: reply.provider,
          model: reply.model,
          // Keep the assistant turn strictly after the user turn so
          // `orderBy createdAt` never interleaves a pair written in the
          // same millisecond.
          createdAt: new Date(now.getTime() + 1),
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

    return {
      roomId: room.id,
      roomTitle: room.title,
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

  /**
   * Every room read/write goes through here — a room is only reachable by the
   * admin who owns it, so one admin can never read another's history.
   */
  private async assertRoomOwner(adminMemberId: string, roomId: string) {
    const room = await this.prisma.adminChatRoom.findFirst({
      where: { id: roomId, adminMemberId },
    });

    if (!room) {
      // Deliberately "not found" rather than "forbidden": an admin should not
      // be able to probe whether another admin's room id exists.
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

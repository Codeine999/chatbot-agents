import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminChatRole,
  Prisma,
} from '../../../generated/prisma/client';
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
    input: { roomId?: string; clientRequestId?: string; text: string },
  ) {
    const text = input.text.trim();
    const clientRequestId = input.clientRequestId ?? randomUUID();
    const request = await this.ensureRequest(
      adminMemberId,
      clientRequestId,
      input.roomId,
      text,
    );
    this.assertSameRequest(request, adminMemberId, input.roomId, text);

    const [room, userMessage] = await Promise.all([
      this.prisma.adminChatRoom.findUniqueOrThrow({
        where: { id: request.roomId },
      }),
      this.prisma.adminChatMessage.findUniqueOrThrow({
        where: { id: request.userMessageId },
        select: this.messageSelect(),
      }),
    ]);

    if (request.assistantMessageId) {
      const reply = await this.prisma.adminChatMessage.findUniqueOrThrow({
        where: { id: request.assistantMessageId },
        select: this.messageSelect(),
      });
      return this.sendResult(room, userMessage, reply, clientRequestId);
    }

    const history = await this.loadContext(room.id);

    let reply: AiGenerateResponse;
    try {
      reply = await this.adminAiProviderService.generate(
        adminMemberId,
        {
          systemInstruction: ADMIN_CHAT_SYSTEM_INSTRUCTION,
          messages: history,
        },
        { idempotencyKey: `admin-chat:${request.id}` },
      );
    } catch (error) {
      this.logger.warn(
        `Admin AI reply failed room=${room.id}: ${String(error)}`,
      );
      throw error;
    }

    const generatedAt = new Date();
    const assistantCreatedAt =
      generatedAt.getTime() > userMessage.createdAt.getTime()
        ? generatedAt
        : new Date(userMessage.createdAt.getTime() + 1);

    const assistantMessage = await this.prisma.$transaction(async (tx) => {
      const message = await tx.adminChatMessage.upsert({
        where: { id: request.id },
        create: {
          id: request.id,
          roomId: room.id,
          role: AdminChatRole.ASSISTANT,
          content: reply.text,
          provider: reply.provider,
          model: reply.model,
          createdAt: assistantCreatedAt,
        },
        update: {},
        select: this.messageSelect(),
      });
      await Promise.all([
        tx.adminChatRequest.update({
          where: { id: request.id },
          data: {
            assistantMessageId: message.id,
            status: 'COMPLETED',
          },
        }),
        tx.adminChatRoom.update({
          where: { id: room.id },
          data: { lastMessageAt: assistantCreatedAt },
        }),
      ]);
      return message;
    });

    return this.sendResult(
      room,
      userMessage,
      assistantMessage,
      clientRequestId,
    );
  }

  private async ensureRequest(
    adminMemberId: string,
    clientRequestId: string,
    roomId: string | undefined,
    text: string,
  ) {
    const existing = await this.prisma.adminChatRequest.findUnique({
      where: { clientRequestId },
    });
    if (existing) return existing;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const raced = await tx.adminChatRequest.findUnique({
            where: { clientRequestId },
          });
          if (raced) return raced;

          const now = new Date();
          const room = roomId
            ? await tx.adminChatRoom.findFirst({
                where: { id: roomId, adminMemberId },
              })
            : await tx.adminChatRoom.create({
                data: { adminMemberId, title: this.deriveTitle(text) },
              });
          if (!room) throw new NotFoundException('Chat room not found');

          const userMessage = await tx.adminChatMessage.create({
            data: {
              roomId: room.id,
              role: AdminChatRole.USER,
              content: text,
              createdAt: now,
            },
          });
          const request = await tx.adminChatRequest.create({
            data: {
              clientRequestId,
              adminMemberId,
              roomId: room.id,
              userMessageId: userMessage.id,
              text,
            },
          });
          await tx.adminChatRoom.update({
            where: { id: room.id },
            data: { lastMessageAt: now },
          });
          return request;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        const raced = await this.prisma.adminChatRequest.findUnique({
          where: { clientRequestId },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private assertSameRequest(
    request: {
      adminMemberId: string;
      roomId: string;
      text: string;
    },
    adminMemberId: string,
    roomId: string | undefined,
    text: string,
  ): void {
    if (
      request.adminMemberId !== adminMemberId ||
      request.text !== text ||
      (roomId !== undefined && request.roomId !== roomId)
    ) {
      throw new ConflictException(
        'clientRequestId has already been used for a different admin message',
      );
    }
  }

  private sendResult(
    room: { id: string; title: string },
    userMessage: unknown,
    reply: unknown,
    clientRequestId: string,
  ) {
    return {
      clientRequestId,
      roomId: room.id,
      roomTitle: room.title,
      userMessage,
      reply,
    };
  }

  private messageSelect() {
    return {
      id: true,
      role: true,
      content: true,
      provider: true,
      model: true,
      createdAt: true,
    } as const;
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

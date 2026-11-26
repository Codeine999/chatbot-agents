import { Injectable } from '@nestjs/common';
import {
  LineChatHistorySource,
  LineChatMessageType,
  LineChatSender,
  Prisma,
} from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import type { StagedMessage } from './csv/line-chat-csv.mapper';
import {
  OVERLAP_TOLERANCE_MS,
  importKeyOf,
  planImportRows,
  type OverlapMode,
} from './line-chat-import.matcher';

const INSERT_CHUNK = 1_000;
/** Batch states in which imported rows may still be written. */
const WRITABLE_BATCH = new Set(['MATERIALIZING', 'COMPLETED']);
const TX_TIMEOUT_MS = 120_000;
const PREVIEW_LENGTH = 200;

export type MaterializeResult =
  | Readonly<{
      status: 'WRITTEN';
      written: number;
      skippedOverlap: number;
      conversationId: string;
    }>
  | Readonly<{ status: 'NOT_READY' }>;

/**
 * The only code that writes imported history into the live LINE tables.
 *
 * Rules it keeps (docs/line-chat-import-plan.md §4, §7):
 * - rows are `source = IMPORT`, `sentStatus = imported`, no lineMessageId /
 *   deliveryId / replyToken / rawEvent, so delivery, AI context and
 *   notifications never see them;
 * - an existing room's `unreadCount` is never touched, and its preview only
 *   moves forward in time;
 * - no network call inside a transaction.
 */
@Injectable()
export class LineChatImportWriter {
  constructor(private readonly prisma: PrismaService) {}

  async materializeThread(
    threadId: string,
    overlapMode: OverlapMode,
  ): Promise<MaterializeResult> {
    const thread = await this.prisma.lineChatImportThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        batchId: true,
        status: true,
        lineMemberId: true,
        messages: true,
      },
    });
    if (
      !thread ||
      thread.status !== 'MATCHED_PENDING_WRITE' ||
      !thread.lineMemberId
    ) {
      return { status: 'NOT_READY' };
    }
    const lineMemberId = thread.lineMemberId;
    const staged = thread.messages as unknown as StagedMessage[];

    // Read the room's LIVE rows around the imported period outside the tx.
    const existing = await this.prisma.lineConversation.findUnique({
      where: { lineMemberId },
      select: { id: true },
    });
    const live = existing ? await this.liveRowsNear(existing.id, staged) : [];
    const plan = planImportRows(staged, live, overlapMode);
    const last = plan.toWrite.at(-1) ?? staged.at(-1);

    const result = await this.prisma.$transaction(
      async (tx) => {
        // FOR SHARE on the batch: a DELETE (status -> DELETING) waits for this
        // write to commit, and no write starts once the batch is being deleted.
        const [batch] = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS status FROM "lineChatImportBatch" WHERE "id" = ${thread.batchId}::uuid FOR SHARE`;
        if (!batch || !WRITABLE_BATCH.has(batch.status)) {
          return { status: 'NOT_READY' } as const;
        }
        // Serialise with a concurrent link/unlink of the same thread.
        const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS status FROM "lineChatImportThread" WHERE "id" = ${threadId}::uuid FOR UPDATE`;
        if (locked?.status !== 'MATCHED_PENDING_WRITE')
          return { status: 'NOT_READY' } as const;

        const lastAt = last ? new Date(last.t) : new Date();
        const lastText = (last?.x ?? '').slice(0, PREVIEW_LENGTH);
        let conversation = await tx.lineConversation.findUnique({
          where: { lineMemberId },
          select: { id: true, lastMessageAt: true },
        });
        let createdConversation = false;

        if (!conversation) {
          conversation = await tx.lineConversation.create({
            data: {
              lineMemberId,
              lastMessage: lastText,
              lastMessageType: LineChatMessageType.TEXT,
              lastMessageAt: lastAt,
              unreadCount: 0,
              importedAt: new Date(),
            },
            select: { id: true, lastMessageAt: true },
          });
          createdConversation = true;
        } else {
          await tx.lineConversation.update({
            where: { id: conversation.id },
            data: {
              importedAt: new Date(),
              ...(last && lastAt > conversation.lastMessageAt
                ? {
                    lastMessage: lastText,
                    lastMessageType: LineChatMessageType.TEXT,
                    lastMessageAt: lastAt,
                  }
                : {}),
            },
          });
        }

        let written = 0;
        for (let i = 0; i < plan.toWrite.length; i += INSERT_CHUNK) {
          const chunk = plan.toWrite.slice(i, i + INSERT_CHUNK);
          const result = await tx.lineChatHistory.createMany({
            data: chunk.map((message) => ({
              conversationId: conversation.id,
              lineMemberId,
              sender:
                message.s === 'U' ? LineChatSender.USER : LineChatSender.ADMIN,
              messageType: LineChatMessageType.TEXT,
              text: message.x,
              sentStatus: 'imported',
              source: LineChatHistorySource.IMPORT,
              importBatchId: thread.batchId,
              importThreadId: thread.id,
              importKey: importKeyOf(lineMemberId, message.h),
              createdAt: new Date(message.t),
            })),
            skipDuplicates: true,
          });
          written += result.count;
        }

        await tx.lineChatImportThread.update({
          where: { id: thread.id },
          data: {
            status: 'MATERIALIZED',
            conversationId: conversation.id,
            createdConversation,
            linkedAt: new Date(),
          },
        });
        return {
          status: 'WRITTEN',
          written,
          skippedOverlap: plan.skippedOverlap,
          conversationId: conversation.id,
        } as const;
      },
      { timeout: TX_TIMEOUT_MS },
    );

    // After commit, not inside the tx: the tx holds the batch row FOR SHARE,
    // and two writers upgrading that lock to UPDATE would deadlock. The
    // counter is a display stat; a retry finds the thread MATERIALIZED and
    // does not count again.
    if (result.status === 'WRITTEN' && result.skippedOverlap > 0) {
      await this.prisma.lineChatImportBatch.update({
        where: { id: thread.batchId },
        data: { skippedOverlap: { increment: result.skippedOverlap } },
      });
    }
    return result;
  }

  /**
   * Removes what a thread wrote and points it elsewhere: back to UNMATCHED, or
   * to another member (MATCHED_PENDING_WRITE, written by the next job). The
   * staged messages stay on the thread, so nothing is lost.
   */
  async detachThread(
    threadId: string,
    next: Readonly<{ lineMemberId: string; linkedById: string }> | null,
  ): Promise<'DETACHED' | 'NOT_LINKED'> {
    return this.prisma.$transaction(
      async (tx) => {
        const [thread] = await tx.$queryRaw<
          Array<{
            status: string;
            conversationId: string | null;
            createdConversation: boolean;
          }>
        >`SELECT "status"::text AS status, "conversationId", "createdConversation"
          FROM "lineChatImportThread" WHERE "id" = ${threadId}::uuid FOR UPDATE`;
        if (
          !thread ||
          !['MATERIALIZED', 'MATCHED_PENDING_WRITE'].includes(thread.status)
        ) {
          return 'NOT_LINKED' as const;
        }

        await tx.lineChatHistory.deleteMany({
          where: {
            importThreadId: threadId,
            source: LineChatHistorySource.IMPORT,
          },
        });
        if (thread.conversationId) {
          await this.tidyConversation(
            tx,
            thread.conversationId,
            thread.createdConversation,
          );
        }

        await tx.lineChatImportThread.update({
          where: { id: threadId },
          data: next
            ? {
                status: 'MATCHED_PENDING_WRITE',
                lineMemberId: next.lineMemberId,
                linkedById: next.linkedById,
                matchMethod: 'admin_manual',
                conversationId: null,
                createdConversation: false,
                linkedAt: null,
              }
            : {
                status: 'UNMATCHED',
                lineMemberId: null,
                linkedById: null,
                matchMethod: null,
                conversationId: null,
                createdConversation: false,
                linkedAt: null,
              },
        });
        return 'DETACHED' as const;
      },
      { timeout: TX_TIMEOUT_MS },
    );
  }

  /**
   * Removes what one thread wrote (by the indexed `importThreadId`), tidies
   * its room, then the thread itself. One small transaction per thread, so
   * deleting a large batch is a series of short steps that can resume.
   */
  async deleteThread(threadId: string): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const thread = await tx.lineChatImportThread.findUnique({
          where: { id: threadId },
          select: { conversationId: true, createdConversation: true },
        });
        if (!thread) return 0;
        const { count } = await tx.lineChatHistory.deleteMany({
          where: {
            importThreadId: threadId,
            source: LineChatHistorySource.IMPORT,
          },
        });
        if (thread.conversationId) {
          await this.tidyConversation(
            tx,
            thread.conversationId,
            thread.createdConversation,
          );
        }
        // deleteMany: a concurrent delete of the same thread is not an error.
        await tx.lineChatImportThread.deleteMany({ where: { id: threadId } });
        return count;
      },
      { timeout: TX_TIMEOUT_MS },
    );
  }

  /**
   * After imported rows left a room: drop a room the import created when it is
   * now empty, otherwise recompute its preview from what remains.
   */
  private async tidyConversation(
    tx: Prisma.TransactionClient,
    conversationId: string,
    createdByImport: boolean,
  ): Promise<void> {
    const latest = await tx.lineChatHistory.findFirst({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { text: true, messageType: true, createdAt: true },
    });

    if (!latest) {
      const turns = await tx.commerceTurn.count({ where: { conversationId } });
      if (createdByImport && turns === 0) {
        await tx.lineConversation.delete({ where: { id: conversationId } });
        return;
      }
      await tx.lineConversation.update({
        where: { id: conversationId },
        data: { importedAt: null },
      });
      return;
    }

    const stillImported = await tx.lineChatHistory.findFirst({
      where: { conversationId, source: LineChatHistorySource.IMPORT },
      select: { id: true },
    });
    await tx.lineConversation.update({
      where: { id: conversationId },
      data: {
        lastMessage: (latest.text ?? '').slice(0, PREVIEW_LENGTH),
        lastMessageType: latest.messageType,
        lastMessageAt: latest.createdAt,
        ...(stillImported ? {} : { importedAt: null }),
      },
    });
  }

  private liveRowsNear(
    conversationId: string,
    staged: readonly StagedMessage[],
  ) {
    if (staged.length === 0) return Promise.resolve([]);
    const lastAt = Date.parse(staged.at(-1)!.t);
    return this.prisma.lineChatHistory
      .aggregate({
        where: { conversationId, source: LineChatHistorySource.LIVE },
        _min: { createdAt: true },
      })
      .then(({ _min }) => {
        const firstLive = _min.createdAt;
        // LIVE history starts after the imported period ends: nothing overlaps.
        if (!firstLive || firstLive.getTime() > lastAt + OVERLAP_TOLERANCE_MS)
          return [];
        return this.prisma.lineChatHistory.findMany({
          where: {
            conversationId,
            source: LineChatHistorySource.LIVE,
            createdAt: { lte: new Date(lastAt + OVERLAP_TOLERANCE_MS) },
          },
          select: { sender: true, text: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        });
      });
  }
}

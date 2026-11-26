import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../../generated/prisma/client';
import type { LineChatImportThreadStatus } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  normalizeCustomerName,
  type StagedMessage,
} from './csv/line-chat-csv.mapper';
import {
  LINE_CHAT_IMPORT_QUEUE,
  lineChatImportSettings,
  type LineChatImportSettings,
} from './line-chat-import.config';
import { IMPORT_JOB, type ThreadJobData } from './line-chat-import.jobs';
import type { ImportOptions } from './line-chat-import.runner';
import { LineChatImportRunner } from './line-chat-import.runner';
import {
  importObjectKey,
  LineChatImportStorage,
} from './line-chat-import.storage';
import { LineChatImportWriter } from './line-chat-import.writer';

type CandidateMember = {
  lineMemberId: string;
  displayName: string;
  pictureUrl: string | null;
  conversationId: string | null;
  lastMessageAt: Date | null;
};

/** Same characters as ZERO_WIDTH in normalizeCustomerName. */
const ZERO_WIDTH_SQL = '[\u200B-\u200D\u2060\uFEFF]';

const RUNNING = [
  'SYNCING_FOLLOWERS',
  'PARSING',
  'MATCHING',
  'MATERIALIZING',
] as const;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** An upload never started is dropped after a day. */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Never select `messages` (large) here; see `preview`. */
const THREAD_LIST_SELECT = {
  id: true,
  batchId: true,
  entryName: true,
  rawName: true,
  normalizedName: true,
  status: true,
  lineMemberId: true,
  conversationId: true,
  matchMethod: true,
  messageCount: true,
  firstAt: true,
  lastAt: true,
  lastText: true,
  linkedAt: true,
} satisfies Prisma.LineChatImportThreadSelect;

const THREAD_LIST_KEYS = Object.keys(THREAD_LIST_SELECT) as Array<
  keyof typeof THREAD_LIST_SELECT
>;

function pick<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}

@Injectable()
export class LineChatImportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LineChatImportService.name);
  private readonly settings: LineChatImportSettings;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LineChatImportStorage,
    private readonly writer: LineChatImportWriter,
    private readonly runner: LineChatImportRunner,
    @InjectQueue(LINE_CHAT_IMPORT_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.settings = lineChatImportSettings(config);
  }

  onModuleInit() {
    if (!this.settings.enabled) return;
    this.timer = setInterval(() => void this.purgeExpired(), PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ upload

  async createUpload(adminId: string, fileName: string, fileSize: number) {
    this.assertEnabled();
    if (fileSize > this.settings.maxZipBytes) {
      throw new PayloadTooLargeException(
        `The backup may be at most ${this.settings.maxZipBytes} bytes`,
      );
    }

    const id = randomUUID();
    const key = importObjectKey(id);
    const multipart = fileSize > this.settings.multipartThresholdBytes;
    const multipartUploadId = multipart
      ? await this.storage.startMultipart(key)
      : null;

    await this.prisma.lineChatImportBatch.create({
      data: {
        id,
        createdById: adminId,
        uploadKey: key,
        multipartUploadId,
        fileName,
        fileSize: BigInt(fileSize),
      },
    });

    if (!multipart) {
      return {
        uploadId: id,
        mode: 'single' as const,
        uploadUrl: await this.storage.presignPut(key, fileSize),
      };
    }
    return {
      uploadId: id,
      mode: 'multipart' as const,
      partSize: this.settings.partSizeBytes,
      partCount: Math.ceil(fileSize / this.settings.partSizeBytes),
    };
  }

  async presignParts(uploadId: string, partNumbers: number[]) {
    const batch = await this.uploading(uploadId);
    if (!batch.multipartUploadId)
      throw new BadRequestException('This upload is a single PUT');
    return {
      parts: await Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await this.storage.presignPart(
            batch.uploadKey,
            batch.multipartUploadId!,
            partNumber,
          ),
        })),
      ),
    };
  }

  async completeUpload(
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ) {
    const batch = await this.uploading(uploadId);
    if (!batch.multipartUploadId)
      throw new BadRequestException('This upload is a single PUT');
    await this.storage.completeMultipart(
      batch.uploadKey,
      batch.multipartUploadId,
      parts,
    );
    await this.prisma.lineChatImportBatch.update({
      where: { id: uploadId },
      data: { multipartUploadId: null },
    });
    return { uploadId, status: 'UPLOADED' as const };
  }

  // ------------------------------------------------------------------- start

  async start(uploadId: string, options: ImportOptions) {
    const batch = await this.uploading(uploadId);
    if (batch.multipartUploadId)
      throw new ConflictException('Finish the multipart upload first');

    // The key is rebuilt from the id, never taken from the client.
    const stored = await this.storage.size(importObjectKey(uploadId));
    if (stored === null)
      throw new BadRequestException('The backup has not been uploaded');
    if (stored > this.settings.maxZipBytes) {
      await this.storage.delete(batch.uploadKey);
      throw new PayloadTooLargeException('The uploaded backup is too large');
    }

    const running = await this.prisma.lineChatImportBatch.findFirst({
      where: { status: { in: [...RUNNING] }, id: { not: uploadId } },
      select: { id: true },
    });
    if (running)
      throw new ConflictException({
        code: 'IMPORT_RUNNING',
        batchId: running.id,
      });

    const firstStatus = options.syncFollowers ? 'SYNCING_FOLLOWERS' : 'PARSING';
    const { count } = await this.prisma.lineChatImportBatch.updateMany({
      where: { id: uploadId, status: 'UPLOADED' },
      data: {
        status: firstStatus,
        fileSize: BigInt(stored),
        options: options,
        startedAt: new Date(),
        expiresAt: new Date(
          Date.now() + this.settings.stagingRetentionDays * 24 * 60 * 60 * 1000,
        ),
      },
    });
    if (count === 0)
      throw new ConflictException('This import has already started');

    await this.runner.enqueue(
      options.syncFollowers ? IMPORT_JOB.syncFollowers : IMPORT_JOB.parse,
      uploadId,
      0,
    );
    return { batchId: uploadId, status: firstStatus };
  }

  // -------------------------------------------------------------------- read

  async list() {
    const batches = await this.prisma.lineChatImportBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return batches.map((batch) => this.batchView(batch));
  }

  async get(batchId: string) {
    const batch = await this.prisma.lineChatImportBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Import not found');
    const counts = await this.prisma.lineChatImportThread.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    return {
      ...this.batchView(batch),
      threads: Object.fromEntries(
        counts.map((row) => [row.status, row._count._all]),
      ),
    };
  }

  async listThreads(
    batchId: string,
    query: {
      status?: LineChatImportThreadStatus;
      q?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    const items = await this.prisma.lineChatImportThread.findMany({
      where: {
        batchId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? { normalizedName: { contains: normalizeCustomerName(query.q) } }
          : {}),
      },
      select: THREAD_LIST_SELECT,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = items.slice(0, query.limit);
    const needCandidates = page.filter(
      (t) => t.status === 'AMBIGUOUS' || t.status === 'UNMATCHED',
    );
    const candidates = await this.candidatesByName(
      needCandidates.map((t) => t.normalizedName),
    );

    return {
      items: page.map((thread) => ({
        ...thread,
        candidates:
          thread.status === 'AMBIGUOUS' || thread.status === 'UNMATCHED'
            ? (candidates.get(thread.normalizedName) ?? [])
            : undefined,
      })),
      nextCursor: items.length > query.limit ? page.at(-1)!.id : null,
    };
  }

  async preview(threadId: string, limit: number) {
    const thread = await this.prisma.lineChatImportThread.findUnique({
      where: { id: threadId },
      select: { ...THREAD_LIST_SELECT, messages: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    const messages = thread.messages as unknown as StagedMessage[];
    return {
      ...pick(thread, THREAD_LIST_KEYS),
      messages: messages.slice(-limit).map((m) => ({
        sender: m.s === 'U' ? 'user' : 'admin',
        text: m.x,
        createdAt: m.t,
      })),
    };
  }

  /** Imported threads that may belong to the customer of this room. */
  async candidatesForConversation(conversationId: string) {
    const conversation = await this.prisma.lineConversation.findUnique({
      where: { id: conversationId },
      select: { lineMember: { select: { displayName: true } } },
    });
    if (!conversation)
      throw new NotFoundException('LINE conversation not found');
    return this.prisma.lineChatImportThread.findMany({
      where: {
        normalizedName: normalizeCustomerName(
          conversation.lineMember.displayName,
        ),
        status: { in: ['UNMATCHED', 'AMBIGUOUS'] },
        batch: { status: 'COMPLETED' },
      },
      select: THREAD_LIST_SELECT,
      take: 20,
    });
  }

  // -------------------------------------------------------------------- link

  async link(threadId: string, lineMemberId: string, adminId: string) {
    const thread = await this.threadOrThrow(threadId);
    if (thread.status !== 'UNMATCHED' && thread.status !== 'AMBIGUOUS') {
      throw new ConflictException('This thread is already linked; use relink');
    }
    await this.assertMemberFree(thread.batchId, lineMemberId, threadId);

    const { count } = await this.prisma.lineChatImportThread.updateMany({
      where: { id: threadId, status: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
      data: {
        status: 'MATCHED_PENDING_WRITE',
        lineMemberId,
        linkedById: adminId,
        matchMethod: 'admin_manual',
      },
    });
    if (count === 0)
      throw new ConflictException('This thread changed; reload and try again');
    await this.enqueueThread(threadId);
    return { threadId, status: 'MATCHED_PENDING_WRITE' as const };
  }

  async relink(threadId: string, lineMemberId: string, adminId: string) {
    const thread = await this.threadOrThrow(threadId);
    if (thread.lineMemberId === lineMemberId)
      throw new BadRequestException('Already linked to this customer');
    await this.assertMemberFree(thread.batchId, lineMemberId, threadId);

    const result = await this.writer.detachThread(threadId, {
      lineMemberId,
      linkedById: adminId,
    });
    if (result === 'NOT_LINKED')
      throw new ConflictException('This thread is not linked; use link');
    await this.enqueueThread(threadId);
    return { threadId, status: 'MATCHED_PENDING_WRITE' as const };
  }

  async unlink(threadId: string) {
    await this.threadOrThrow(threadId);
    const result = await this.writer.detachThread(threadId, null);
    if (result === 'NOT_LINKED')
      throw new ConflictException('This thread is not linked');
    return { threadId, status: 'UNMATCHED' as const };
  }

  // ------------------------------------------------------- cancel and delete

  async cancel(batchId: string) {
    const batch = await this.prisma.lineChatImportBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Import not found');
    if (!['UPLOADED', ...RUNNING].includes(batch.status)) {
      throw new ConflictException(
        'Only an import that has not finished can be cancelled',
      );
    }
    await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    if (batch.multipartUploadId) {
      await this.storage
        .abortMultipart(batch.uploadKey, batch.multipartUploadId)
        .catch(() => undefined);
    }
    await this.storage.delete(batch.uploadKey).catch(() => undefined);
    return { batchId, status: 'CANCELLED' as const };
  }

  /** Removes everything the batch wrote. Runs as a job: it can be millions of rows. */
  async remove(batchId: string) {
    const batch = await this.prisma.lineChatImportBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Import not found');
    // Already being deleted: answer the same, start nothing (a second chain
    // would race the first). A delete that failed is FAILED and can rerun.
    if (batch.status === 'DELETING') {
      return { batchId, status: 'DELETING' as const };
    }
    // DELETING blocks link/relink/unlink and new writes (the writer holds the
    // batch row FOR SHARE, so this update also waits for a write in flight).
    const { count } = await this.prisma.lineChatImportBatch.updateMany({
      where: { id: batchId, status: { notIn: [...RUNNING, 'DELETING'] } },
      data: { status: 'DELETING' },
    });
    if (count === 0) {
      // A concurrent DELETE won the update, or the import is still running.
      const now = await this.prisma.lineChatImportBatch.findUnique({
        where: { id: batchId },
        select: { status: true },
      });
      if (now?.status === 'DELETING') {
        return { batchId, status: 'DELETING' as const };
      }
      throw new ConflictException('Cancel the import before deleting it');
    }
    // Chunk numbers start from the clock so a retried DELETE never collides
    // with job ids BullMQ still keeps from an earlier attempt.
    await this.runner.enqueue(IMPORT_JOB.deleteBatch, batchId, Date.now());
    return { batchId, status: 'DELETING' as const };
  }

  /**
   * Retention: an expired batch keeps its row and threads (audit, and DELETE
   * can still roll it back) but its staged messages are cleared, in bounded
   * updates, and it becomes EXPIRED so nothing links to it any more.
   * Uploads never started are removed.
   */
  async purgeExpired(): Promise<void> {
    try {
      const expired = await this.prisma.lineChatImportBatch.findMany({
        where: {
          expiresAt: { lt: new Date() },
          status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
        },
        select: { id: true },
        take: 20,
      });
      for (const batch of expired) await this.clearStaging(batch.id);

      const stale = await this.prisma.lineChatImportBatch.findMany({
        where: {
          status: 'UPLOADED',
          createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) },
        },
        select: { id: true },
      });
      for (const batch of stale)
        await this.cancel(batch.id).catch(() => undefined);
      if (expired.length > 0 || stale.length > 0) {
        this.logger.log(
          `Import purge: ${expired.length} expired, ${stale.length} stale uploads`,
        );
      }
    } catch (error) {
      this.logger.warn(`Import purge failed: ${String(error)}`);
    }
  }

  private async clearStaging(batchId: string): Promise<void> {
    await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: { status: 'EXPIRED' },
    });
    // Keyset by id: never compares the (large) messages column itself.
    for (let after = '00000000-0000-0000-0000-000000000000'; ; ) {
      const ids = await this.prisma.lineChatImportThread.findMany({
        where: { batchId, id: { gt: after } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 1_000,
      });
      if (ids.length === 0) break;
      await this.prisma.lineChatImportThread.updateMany({
        where: { id: { in: ids.map((row) => row.id) } },
        data: { messages: [] },
      });
      after = ids[ids.length - 1].id;
    }
  }

  // ------------------------------------------------------------------ helpers

  private assertEnabled() {
    if (!this.settings.enabled)
      throw new ServiceUnavailableException('LINE chat import is disabled');
    this.storage.assertAvailable();
  }

  private async uploading(uploadId: string) {
    this.assertEnabled();
    const batch = await this.prisma.lineChatImportBatch.findUnique({
      where: { id: uploadId },
    });
    if (!batch) throw new NotFoundException('Upload not found');
    if (batch.status !== 'UPLOADED')
      throw new ConflictException('This import has already started');
    return batch;
  }

  /**
   * Link, relink and unlink only touch threads of a COMPLETED batch: not one
   * still running, being deleted, or expired (its staged messages are gone,
   * so an unlink could not be undone).
   */
  private async threadOrThrow(threadId: string) {
    const thread = await this.prisma.lineChatImportThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        batchId: true,
        status: true,
        lineMemberId: true,
        batch: { select: { status: true } },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (thread.batch.status !== 'COMPLETED') {
      throw new ConflictException({
        code: 'BATCH_NOT_EDITABLE',
        batchStatus: thread.batch.status,
      });
    }
    return thread;
  }

  private async assertMemberFree(
    batchId: string,
    lineMemberId: string,
    threadId: string,
  ) {
    const member = await this.prisma.lineMember.findUnique({
      where: { id: lineMemberId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('LINE member not found');
    const other = await this.prisma.lineChatImportThread.findFirst({
      where: {
        batchId,
        lineMemberId,
        id: { not: threadId },
        status: { in: ['MATCHED_PENDING_WRITE', 'MATERIALIZED'] },
      },
      select: { id: true },
    });
    if (other) {
      throw new ConflictException({
        code: 'MEMBER_ALREADY_LINKED',
        threadId: other.id,
      });
    }
  }

  private async enqueueThread(threadId: string) {
    await this.queue.add(
      IMPORT_JOB.materializeThread,
      { threadId } satisfies ThreadJobData,
      { jobId: `${IMPORT_JOB.materializeThread}_${threadId}_${Date.now()}` },
    );
  }

  /**
   * Members whose name normalizes to one of `keys` (thread normalizedName).
   * The SQL mirrors `normalizeCustomerName` (NFKC, zero-width removed,
   * spaces collapsed, trimmed, lower-case) so candidates are exactly the
   * members MATCH compared against. At most 20 per name.
   */
  private async candidatesByName(keys: string[]) {
    const result = new Map<string, CandidateMember[]>();
    if (keys.length === 0) return result;
    const rows = await this.prisma.$queryRaw<
      Array<CandidateMember & { key: string }>
    >`
      SELECT m."id" AS "lineMemberId", m."displayName", m."pictureUrl",
             c."id" AS "conversationId", c."lastMessageAt", m.key
      FROM (
        SELECT n.*, row_number() OVER (PARTITION BY n.key ORDER BY n."lastActiveAt" DESC NULLS LAST) AS rank
        FROM (
          SELECT lm.*, lower(btrim(regexp_replace(
                   regexp_replace(normalize(lm."displayName", NFKC), ${ZERO_WIDTH_SQL}, '', 'g'),
                   '\\s+', ' ', 'g'))) AS key
          FROM "lineMember" lm
        ) n
        WHERE n.key = ANY(${[...new Set(keys)]}::text[])
      ) m
      LEFT JOIN "lineConversation" c ON c."lineMemberId" = m."id"
      WHERE m.rank <= 20`;
    for (const { key, ...member } of rows) {
      const list = result.get(key) ?? [];
      list.push(member);
      result.set(key, list);
    }
    return result;
  }

  /** The batch without its storage key, upload id and checkpoint. */
  private batchView(batch: Prisma.LineChatImportBatchGetPayload<object>) {
    const {
      uploadKey: _key,
      multipartUploadId,
      cursor: _cursor,
      fileSize,
      ...rest
    } = batch;
    void _key;
    void _cursor;
    return {
      ...rest,
      fileSize: Number(fileSize),
      uploading: multipartUploadId !== null,
      progress: {
        parsedEntries: batch.parsedEntries,
        totalEntries: batch.totalEntries,
      },
    };
  }
}

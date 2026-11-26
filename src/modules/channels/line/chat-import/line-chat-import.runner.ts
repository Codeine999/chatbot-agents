import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { mkdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Prisma } from '../../../../generated/prisma/client';
import type { LineChatImportStatus } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { LineAdminService } from '../admin/line-admin.service';
import { LineApiError } from '../admin/line-api.utils';
import {
  fileNameToCustomerName,
  normalizeCustomerName,
  type StagedMessage,
} from './csv/line-chat-csv.mapper';
import { readLineChatCsv } from './csv/line-chat-csv.reader';
import {
  LINE_CHAT_IMPORT_QUEUE,
  lineChatImportSettings,
  type LineChatImportSettings,
} from './line-chat-import.config';
import {
  IMPORT_JOB,
  batchJobId,
  type BatchJobData,
  type ImportJobName,
} from './line-chat-import.jobs';
import { matchThreads, type OverlapMode } from './line-chat-import.matcher';
import { LineChatImportStorage } from './line-chat-import.storage';
import { LineChatImportWriter } from './line-chat-import.writer';
import { LineChatZipReader, ZipLimitError } from './zip/line-chat-zip.reader';

export type ImportOptions = Readonly<{
  fromDate?: string | null;
  toDate?: string | null;
  syncFollowers?: boolean;
  overlapMode?: OverlapMode;
  dryRun?: boolean;
}>;

type Cursor = {
  followersNext?: string | null;
  followersUnavailable?: boolean;
  nextEntry?: number;
};

/** A chunk stops after this long and hands over to the next job (checkpoint in `cursor`). */
const CHUNK_TIME_MS = 90_000;
const PARSE_ENTRIES_PER_CHUNK = 500;
const MATERIALIZE_THREADS_PER_CHUNK = 100;
const MAX_ERROR_SAMPLES = 20;
const MAX_PROFILE_ATTEMPTS = 4;
/** Profiles saved per write while syncing followers. */
const FOLLOWER_FLUSH = 100;
/** Parsed entries written per transaction. */
const PARSE_ENTRIES_PER_TX = 50;
/** Threads removed per delete-batch chunk. */
const DELETE_THREADS_PER_CHUNK = 200;

type ParsedEntry = {
  row: Omit<
    Prisma.LineChatImportThreadCreateManyInput,
    'batchId' | 'messages'
  > & {
    entryIndex: number;
    messageCount: number;
    messages: StagedMessage[];
  };
  skippedByDate: number;
  errorRows: number;
  samples: Array<{ entry: string; line: number; reason: string }>;
};

/**
 * The stages of one batch. Every stage works in chunks: it does a bounded
 * amount of work, saves a checkpoint, then enqueues the next chunk. A worker
 * that dies mid-chunk is retried by BullMQ and resumes from the checkpoint;
 * every write is idempotent (unique keys), so a repeated chunk adds nothing.
 */
@Injectable()
export class LineChatImportRunner {
  private readonly logger = new Logger(LineChatImportRunner.name);
  private readonly settings: LineChatImportSettings;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LineChatImportStorage,
    private readonly writer: LineChatImportWriter,
    private readonly lineAdmin: LineAdminService,
    @InjectQueue(LINE_CHAT_IMPORT_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.settings = lineChatImportSettings(config);
  }

  zipPath(batchId: string): string {
    return join(this.settings.tmpDir, `${batchId}.zip`);
  }

  async enqueue(
    name: ImportJobName,
    batchId: string,
    chunk: number,
  ): Promise<void> {
    await this.queue.add(name, { batchId, chunk } satisfies BatchJobData, {
      jobId: batchJobId(name, batchId, chunk),
    });
  }

  // ---------------------------------------------------------------- followers

  async syncFollowers({ batchId, chunk }: BatchJobData): Promise<void> {
    const batch = await this.activeBatch(batchId, 'SYNCING_FOLLOWERS');
    if (!batch) return;
    const cursor = (batch.cursor ?? {}) as Cursor;

    let page: { userIds: string[]; next?: string };
    try {
      page = await this.lineAdmin.getFollowerIds(
        cursor.followersNext ?? undefined,
      );
    } catch (error) {
      if (
        error instanceof LineApiError &&
        (error.status === 403 || error.status === 401)
      ) {
        // Unverified OA: no follower list. Imported threads link lazily instead.
        await this.advance(batchId, 'PARSING', {
          ...cursor,
          followersUnavailable: true,
        });
        return this.enqueue(IMPORT_JOB.parse, batchId, 0);
      }
      throw error;
    }

    const known = new Set(
      (
        await this.prisma.lineMember.findMany({
          where: { lineUserId: { in: page.userIds } },
          select: { lineUserId: true },
        })
      ).map((member) => member.lineUserId),
    );

    const gapMs = 1000 / this.settings.profileRps;
    let created: Prisma.LineMemberCreateManyInput[] = [];
    // Saved every FOLLOWER_FLUSH profiles: a retried page skips the members
    // already saved (`known` above) instead of calling LINE for them again.
    const flush = async () => {
      if (created.length === 0) return;
      // skipDuplicates: a member the webhook created meanwhile keeps its own row.
      const { count } = await this.prisma.lineMember.createMany({
        data: created,
        skipDuplicates: true,
      });
      created = [];
      await this.prisma.lineChatImportBatch.update({
        where: { id: batchId },
        data: { syncedFollowers: { increment: count } },
      });
    };

    for (const userId of page.userIds) {
      if (known.has(userId)) continue;
      const profile = await this.profileWithBackoff(userId);
      await sleep(gapMs);
      if (!profile) continue;
      created.push({
        lineUserId: userId,
        displayName: profile.displayName || userId,
        pictureUrl: profile.pictureUrl,
        statusMessage: profile.statusMessage,
        profileSyncedAt: new Date(),
        source: 'followers_sync',
      });
      if (created.length >= FOLLOWER_FLUSH) await flush();
    }
    await flush();

    await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: { cursor: { ...cursor, followersNext: page.next ?? null } },
    });

    if (page.next)
      return this.enqueue(IMPORT_JOB.syncFollowers, batchId, chunk + 1);
    await this.advance(batchId, 'PARSING');
    return this.enqueue(IMPORT_JOB.parse, batchId, 0);
  }

  private async profileWithBackoff(userId: string) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.lineAdmin.findProfile(userId);
      } catch (error) {
        const retryable =
          error instanceof LineApiError &&
          (error.status === 429 || error.status >= 500);
        if (!retryable || attempt >= MAX_PROFILE_ATTEMPTS) throw error;
        const waitSeconds = error.retryAfterSeconds ?? 2 ** attempt;
        this.logger.warn(
          `LINE profile ${error.status}; waiting ${waitSeconds}s`,
        );
        await sleep(waitSeconds * 1000);
      }
    }
  }

  // -------------------------------------------------------------------- parse

  async parse({ batchId, chunk }: BatchJobData): Promise<void> {
    const batch = await this.activeBatch(batchId, 'PARSING');
    if (!batch) return;
    const options = (batch.options ?? {}) as ImportOptions;
    const cursor = (batch.cursor ?? {}) as Cursor;
    const path = this.zipPath(batchId);

    await this.ensureLocalZip(batch.uploadKey, Number(batch.fileSize), path);

    let reader: LineChatZipReader;
    try {
      reader = await LineChatZipReader.open(path, {
        maxEntries: this.settings.maxEntries,
        maxUncompressedBytes: this.settings.maxUncompressedBytes,
        maxEntryBytes: this.settings.maxEntryBytes,
        maxRatio: 100,
      });
    } catch (error) {
      if (error instanceof ZipLimitError)
        return this.fail(batchId, `ZIP_${error.reason}`, true);
      // yauzl rejects corrupt or non-zip files with a plain Error.
      return this.fail(batchId, 'ZIP_INVALID', true);
    }

    const startedAt = Date.now();
    let index = cursor.nextEntry ?? 0;
    try {
      if (batch.totalEntries !== reader.count) {
        await this.prisma.lineChatImportBatch.update({
          where: { id: batchId },
          data: { totalEntries: reader.count },
        });
      }

      let samples = ((batch.errorSamples ?? []) as unknown[]).length;
      let pending: ParsedEntry[] = [];
      for (
        let done = 0;
        index < reader.count &&
        done < PARSE_ENTRIES_PER_CHUNK &&
        Date.now() - startedAt < CHUNK_TIME_MS;
        index += 1, done += 1
      ) {
        const entry = await this.parseEntry(
          reader,
          index,
          options,
          batch.createdAt,
        );
        entry.samples = entry.samples.slice(
          0,
          Math.max(0, MAX_ERROR_SAMPLES - samples),
        );
        samples += entry.samples.length;
        pending.push(entry);
        if (pending.length >= PARSE_ENTRIES_PER_TX) {
          await this.saveParsed(batchId, pending);
          pending = [];
        }
      }
      await this.saveParsed(batchId, pending);
    } finally {
      reader.close();
    }

    await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: {
        cursor: { ...cursor, nextEntry: index },
      },
    });

    if (index < reader.count)
      return this.enqueue(IMPORT_JOB.parse, batchId, chunk + 1);

    // Everything is staged: the raw backup (PII) is no longer needed anywhere.
    await this.storage.delete(batch.uploadKey);
    await rm(path, { force: true });
    await this.advance(batchId, 'MATCHING');
    return this.enqueue(IMPORT_JOB.match, batchId, 0);
  }

  private async parseEntry(
    reader: LineChatZipReader,
    index: number,
    options: ImportOptions,
    fallbackAt: Date,
  ): Promise<ParsedEntry> {
    const info = reader.info(index);
    const entry = info.fileName.slice(0, 120);
    try {
      const file = await readLineChatCsv(await reader.stream(index), {
        fileName: info.fileName,
        utcOffsetMinutes: this.settings.utcOffsetMinutes,
        fromDate: options.fromDate,
        toDate: options.toDate,
        extraAliases: this.settings.columnAliases,
      });
      const first = file.messages[0];
      const last = file.messages.at(-1);
      return {
        row: {
          entryIndex: index,
          entryName: info.fileName.slice(0, 512),
          rawName: file.rawName,
          normalizedName: normalizeCustomerName(file.rawName),
          status:
            /^unknown$/i.test(file.rawName) || !first ? 'SKIPPED' : 'PENDING',
          messageCount: file.messages.length,
          firstAt: first ? new Date(first.t) : fallbackAt,
          lastAt: last ? new Date(last.t) : fallbackAt,
          lastText: last?.x.slice(0, 200) ?? null,
          messages: file.messages,
        },
        skippedByDate: file.skippedByDate,
        errorRows: file.errors.length,
        samples: file.errors.map((error) => ({
          entry,
          line: error.line,
          reason: error.reason,
        })),
      };
    } catch (error) {
      // A corrupt entry (bad deflate data, a size lie caught by yauzl) fails
      // the same way on every retry: skip it instead of failing the batch.
      this.logger.warn(`Import entry ${index} unreadable: ${String(error)}`);
      const rawName =
        fileNameToCustomerName(info.fileName).slice(0, 255) || 'Unknown';
      return {
        row: {
          entryIndex: index,
          entryName: info.fileName.slice(0, 512),
          rawName,
          normalizedName: normalizeCustomerName(rawName),
          status: 'SKIPPED',
          messageCount: 0,
          firstAt: fallbackAt,
          lastAt: fallbackAt,
          lastText: null,
          messages: [],
        },
        skippedByDate: 0,
        errorRows: 1,
        samples: [{ entry, line: 0, reason: 'ENTRY_UNREADABLE' }],
      };
    }
  }

  /** One transaction per group of entries; totals count only rows this run inserted. */
  private async saveParsed(batchId: string, entries: ParsedEntry[]) {
    if (entries.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.lineChatImportThread.createManyAndReturn({
        data: entries.map((entry) => ({ batchId, ...entry.row })),
        skipDuplicates: true,
        select: { entryIndex: true },
      });
      const fresh = new Set(inserted.map((row) => row.entryIndex));
      const counted = entries.filter((entry) =>
        fresh.has(entry.row.entryIndex),
      );
      if (counted.length === 0) return;

      const sum = (pick: (entry: ParsedEntry) => number) =>
        counted.reduce((total, entry) => total + pick(entry), 0);
      const samples = counted.flatMap((entry) => entry.samples);
      await tx.$executeRaw`
        UPDATE "lineChatImportBatch" SET
          "parsedEntries" = "parsedEntries" + ${counted.length},
          "totalMessages" = "totalMessages" + ${sum((e) => e.row.messageCount)},
          "skippedByDate" = "skippedByDate" + ${sum((e) => e.skippedByDate)},
          "errorRows" = "errorRows" + ${sum((e) => e.errorRows)},
          "errorSamples" = COALESCE("errorSamples", '[]'::jsonb) || ${JSON.stringify(samples)}::jsonb,
          "updatedAt" = now()
        WHERE "id" = ${batchId}::uuid`;
    });
  }

  private async ensureLocalZip(
    key: string,
    size: number,
    path: string,
  ): Promise<void> {
    const local = await stat(path).catch(() => null);
    if (local?.size === size) return;

    await rm(path, { force: true });
    await mkdir(this.settings.tmpDir, { recursive: true });
    const disk = await statfs(this.settings.tmpDir);
    if (disk.bavail * disk.bsize < size * 1.2) {
      throw new Error(`INSUFFICIENT_DISK in ${this.settings.tmpDir}`);
    }
    await this.storage.download(key, path);
  }

  // -------------------------------------------------------------------- match

  async match({ batchId }: BatchJobData): Promise<void> {
    const batch = await this.activeBatch(batchId, 'MATCHING');
    if (!batch) return;

    // Decide over every thread of the batch, not only those still PENDING:
    // after a crash mid-way, a thread already set AMBIGUOUS still shares its
    // name with a PENDING one, which must stay AMBIGUOUS too (never linked
    // alone). Nothing else changes thread states during MATCHING, so this is
    // the same input as the first attempt; the updates below only touch rows
    // that are still PENDING.
    const threads = await this.prisma.lineChatImportThread.findMany({
      where: { batchId, status: { not: 'SKIPPED' } },
      select: { id: true, normalizedName: true },
    });

    const membersByName = new Map<string, string[]>();
    for (const member of await this.prisma.lineMember.findMany({
      select: { id: true, displayName: true },
    })) {
      const key = normalizeCustomerName(member.displayName);
      const list = membersByName.get(key);
      if (list) list.push(member.id);
      else membersByName.set(key, [member.id]);
    }

    const decisions = matchThreads(threads, membersByName);
    const matched = decisions.filter((d) => d.status === 'MATCHED');
    const byStatus = (status: 'UNMATCHED' | 'AMBIGUOUS') =>
      decisions.filter((d) => d.status === status).map((d) => d.threadId);

    for (let i = 0; i < matched.length; i += 5_000) {
      const slice = matched.slice(i, i + 5_000);
      await this.prisma.$executeRaw`
        UPDATE "lineChatImportThread" AS t SET
          "status" = 'MATCHED_PENDING_WRITE',
          "lineMemberId" = m.member,
          "matchMethod" = 'followers_name',
          "updatedAt" = now()
        FROM unnest(${slice.map((d) => d.threadId)}::uuid[], ${slice.map((d) => d.lineMemberId)}::uuid[])
          AS m(thread, member)
        WHERE t."id" = m.thread AND t."status" = 'PENDING'`;
    }
    for (const status of ['UNMATCHED', 'AMBIGUOUS'] as const) {
      const ids = byStatus(status);
      for (let i = 0; i < ids.length; i += 5_000) {
        await this.prisma.lineChatImportThread.updateMany({
          where: { id: { in: ids.slice(i, i + 5_000) }, status: 'PENDING' },
          data: { status },
        });
      }
    }

    // Counted from the table, not from this run: a retried match only sees
    // the threads an earlier attempt left PENDING.
    const counts = new Map(
      (
        await this.prisma.lineChatImportThread.groupBy({
          by: ['status'],
          where: { batchId },
          _count: { _all: true },
        })
      ).map((row) => [row.status, row._count._all]),
    );
    const options = (batch.options ?? {}) as ImportOptions;
    await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: {
        linkedThreads: counts.get('MATCHED_PENDING_WRITE') ?? 0,
        unmatchedThreads: counts.get('UNMATCHED') ?? 0,
        ambiguousThreads: counts.get('AMBIGUOUS') ?? 0,
      },
    });

    if (options.dryRun) return this.complete(batchId);
    await this.advance(batchId, 'MATERIALIZING');
    return this.enqueue(IMPORT_JOB.materialize, batchId, 0);
  }

  // -------------------------------------------------------------- materialize

  async materialize({ batchId, chunk }: BatchJobData): Promise<void> {
    const batch = await this.activeBatch(batchId, 'MATERIALIZING');
    if (!batch) return;
    const overlapMode =
      ((batch.options ?? {}) as ImportOptions).overlapMode ?? 'dedupe';

    const threads = await this.prisma.lineChatImportThread.findMany({
      where: { batchId, status: 'MATCHED_PENDING_WRITE' },
      select: { id: true },
      orderBy: { entryIndex: 'asc' },
      take: MATERIALIZE_THREADS_PER_CHUNK,
    });

    const startedAt = Date.now();
    for (const thread of threads) {
      await this.writer.materializeThread(thread.id, overlapMode);
      if (Date.now() - startedAt > CHUNK_TIME_MS) break;
    }

    const remaining = await this.prisma.lineChatImportThread.count({
      where: { batchId, status: 'MATCHED_PENDING_WRITE' },
    });
    if (remaining > 0)
      return this.enqueue(IMPORT_JOB.materialize, batchId, chunk + 1);
    return this.complete(batchId);
  }

  /** One thread linked by an admin or by the customer's first message. */
  async materializeOne(threadId: string): Promise<void> {
    const thread = await this.prisma.lineChatImportThread.findUnique({
      where: { id: threadId },
      select: { batch: { select: { options: true } } },
    });
    if (!thread) return;
    const overlapMode =
      ((thread.batch.options ?? {}) as ImportOptions).overlapMode ?? 'dedupe';
    await this.writer.materializeThread(threadId, overlapMode);
  }

  /** Lazy link: a new customer whose name exactly one waiting thread carries. */
  async linkNewMember(lineMemberId: string): Promise<void> {
    const member = await this.prisma.lineMember.findUnique({
      where: { id: lineMemberId },
      select: { id: true, displayName: true },
    });
    if (!member) return;

    const candidates = await this.prisma.lineChatImportThread.findMany({
      where: {
        normalizedName: normalizeCustomerName(member.displayName),
        status: 'UNMATCHED',
        batch: { status: 'COMPLETED' },
      },
      select: { id: true },
      take: 2,
    });
    if (candidates.length === 0) return;
    if (candidates.length > 1) {
      // Two old chats carry this name: an admin must pick.
      await this.prisma.lineChatImportThread.updateMany({
        where: {
          normalizedName: normalizeCustomerName(member.displayName),
          status: 'UNMATCHED',
          batch: { status: 'COMPLETED' },
        },
        data: { status: 'AMBIGUOUS' },
      });
      return;
    }

    const { count } = await this.prisma.lineChatImportThread.updateMany({
      where: { id: candidates[0].id, status: 'UNMATCHED' },
      data: {
        status: 'MATCHED_PENDING_WRITE',
        lineMemberId,
        matchMethod: 'lazy_first_message',
      },
    });
    if (count === 1) await this.materializeOne(candidates[0].id);
  }

  /**
   * Rolls a batch back in chunks: each chunk removes the rows and rooms of a
   * few hundred threads (one short transaction per thread), then hands over
   * to the next chunk. The batch row goes last.
   */
  async deleteBatch({ batchId, chunk }: BatchJobData): Promise<void> {
    const batch = await this.activeBatch(batchId, 'DELETING');
    if (!batch) return;

    const written = await this.prisma.lineChatImportThread.findMany({
      where: { batchId, conversationId: { not: null } },
      select: { id: true },
      take: DELETE_THREADS_PER_CHUNK,
    });
    for (const thread of written) await this.writer.deleteThread(thread.id);
    if (written.length === DELETE_THREADS_PER_CHUNK) {
      return this.enqueue(IMPORT_JOB.deleteBatch, batchId, chunk + 1);
    }

    // What is left wrote nothing: drop it in bounded statements, not one cascade.
    for (;;) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM "lineChatImportThread" WHERE "id" IN (
          SELECT "id" FROM "lineChatImportThread" WHERE "batchId" = ${batchId}::uuid
          LIMIT ${DELETE_THREADS_PER_CHUNK * 5})`;
      if (removed === 0) break;
    }
    if (batch.multipartUploadId) {
      await this.storage
        .abortMultipart(batch.uploadKey, batch.multipartUploadId)
        .catch(() => undefined);
    }
    await this.storage.delete(batch.uploadKey).catch(() => undefined);
    await this.prisma.lineChatImportBatch.delete({ where: { id: batchId } });
    await rm(this.zipPath(batchId), { force: true });
    this.logger.log(`Import batch ${batchId} deleted`);
  }

  // ------------------------------------------------------------------ helpers

  private async activeBatch(batchId: string, expected: LineChatImportStatus) {
    const batch = await this.prisma.lineChatImportBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch || batch.status !== expected) {
      // Cancelled, deleted, or a stale duplicate of a finished chunk.
      if (batch?.status === 'CANCELLED')
        await rm(this.zipPath(batchId), { force: true });
      return null;
    }
    return batch;
  }

  private async advance(
    batchId: string,
    status: LineChatImportStatus,
    cursor?: Cursor,
  ) {
    await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: {
        status,
        ...(cursor ? { cursor: cursor } : {}),
      },
    });
  }

  private async complete(batchId: string) {
    await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: { status: 'COMPLETED', finishedAt: new Date() },
    });
  }

  /** A failure no retry can fix (bad zip). Transient errors throw and BullMQ retries them. */
  async fail(
    batchId: string,
    reason: string,
    dropUpload = false,
  ): Promise<void> {
    const batch = await this.prisma.lineChatImportBatch.update({
      where: { id: batchId },
      data: { status: 'FAILED', errorMessage: reason, finishedAt: new Date() },
      select: { uploadKey: true },
    });
    if (dropUpload)
      await this.storage.delete(batch.uploadKey).catch(() => undefined);
    await rm(this.zipPath(batchId), { force: true });
  }
}

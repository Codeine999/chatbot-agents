import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { LINE_CHAT_IMPORT_QUEUE } from './line-chat-import.config';
import {
  IMPORT_JOB,
  type BatchJobData,
  type MemberJobData,
  type ThreadJobData,
} from './line-chat-import.jobs';
import { LineChatImportRunner } from './line-chat-import.runner';

const BATCH_JOBS = new Set<string>([
  IMPORT_JOB.syncFollowers,
  IMPORT_JOB.parse,
  IMPORT_JOB.match,
  IMPORT_JOB.materialize,
  IMPORT_JOB.deleteBatch,
]);

/**
 * One job at a time per instance: imports are heavy and never urgent. Chunks
 * are short and async (the CSV reader yields to the event loop), so BullMQ's
 * lock renewal keeps working; the long lock only covers a slow download.
 */
@Processor(LINE_CHAT_IMPORT_QUEUE, { concurrency: 1, lockDuration: 120_000 })
export class LineChatImportProcessor extends WorkerHost {
  private readonly logger = new Logger(LineChatImportProcessor.name);

  constructor(private readonly runner: LineChatImportRunner) {
    super();
  }

  process(job: Job): Promise<void> {
    switch (job.name) {
      case IMPORT_JOB.syncFollowers:
        return this.runner.syncFollowers(job.data as BatchJobData);
      case IMPORT_JOB.parse:
        return this.runner.parse(job.data as BatchJobData);
      case IMPORT_JOB.match:
        return this.runner.match(job.data as BatchJobData);
      case IMPORT_JOB.materialize:
        return this.runner.materialize(job.data as BatchJobData);
      case IMPORT_JOB.materializeThread:
        return this.runner.materializeOne((job.data as ThreadJobData).threadId);
      case IMPORT_JOB.linkNewMember:
        return this.runner.linkNewMember(
          (job.data as MemberJobData).lineMemberId,
        );
      case IMPORT_JOB.deleteBatch:
        return this.runner.deleteBatch(job.data as BatchJobData);
      default:
        throw new UnrecoverableError(`Unknown import job ${job.name}`);
    }
  }

  /** A stage that used up its retries would leave the batch "running" forever. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job) return;
    const final =
      job.attemptsMade >= (job.opts.attempts ?? 1) ||
      error instanceof UnrecoverableError;
    this.logger.warn(
      `Import job ${job.name} ${job.id} failed (attempt ${job.attemptsMade}): ${error.message}`,
    );
    if (!final || !BATCH_JOBS.has(job.name)) return;
    await this.runner
      .fail(
        (job.data as BatchJobData).batchId,
        `${job.name}: ${error.message}`.slice(0, 500),
      )
      .catch((failError: unknown) =>
        this.logger.error(`Could not mark import failed: ${String(failError)}`),
      );
  }
}

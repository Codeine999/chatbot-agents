import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../../prisma/prisma.service';
import { normalizeCustomerName } from './csv/line-chat-csv.mapper';
import {
  LINE_CHAT_IMPORT_QUEUE,
  lineChatImportSettings,
} from './line-chat-import.config';
import { IMPORT_JOB, type MemberJobData } from './line-chat-import.jobs';

/**
 * Called by the webhook path right after it created a new LINE member: if an
 * imported thread carries that customer's name, link it in the background.
 *
 * Never throws and never blocks the reply: one indexed lookup, then a job.
 * The job id is per member, so two webhooks racing to create the same member
 * enqueue one job.
 */
@Injectable()
export class LineChatImportHook {
  private readonly logger = new Logger(LineChatImportHook.name);
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(LINE_CHAT_IMPORT_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.enabled = lineChatImportSettings(config).enabled;
  }

  async memberCreated(member: {
    id: string;
    displayName: string;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      const waiting = await this.prisma.lineChatImportThread.findFirst({
        where: {
          normalizedName: normalizeCustomerName(member.displayName),
          status: 'UNMATCHED',
        },
        select: { id: true },
      });
      if (!waiting) return;

      await this.queue.add(
        IMPORT_JOB.linkNewMember,
        { lineMemberId: member.id } satisfies MemberJobData,
        // A short delay lets the webhook commit the customer's first message first.
        { jobId: `${IMPORT_JOB.linkNewMember}_${member.id}`, delay: 5_000 },
      );
    } catch (error) {
      this.logger.warn(
        `Import link check failed for ${member.id}: ${String(error)}`,
      );
    }
  }
}

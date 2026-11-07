import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { CompanyService } from '../admin/company/company.service';
import type { DecisionTraceState } from './types/decision-log.types';
import {
  buildDecisionLogRow,
  type DecisionLogOutcome,
} from './utils/decision-log.builder';

const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Writes one row per customer turn and purges rows past retention. A log is
 * diagnostics: a failed write is reported and swallowed, so it can never
 * change or delay what the customer receives.
 */
@Injectable()
export class DecisionLogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DecisionLogService.name);
  private readonly enabled: boolean;
  private readonly retentionDays: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompanyService,
    config: ConfigService,
  ) {
    this.enabled =
      String(config.get('DECISION_LOG_ENABLED') ?? 'true').toLowerCase() !==
      'false';
    this.retentionDays = z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .parse(config.get('DECISION_LOG_RETENTION_DAYS') ?? 90);
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.purgeExpired(), PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async save(
    state: DecisionTraceState | undefined,
    outcome: DecisionLogOutcome,
  ): Promise<void> {
    if (!this.enabled || !state) return;
    try {
      const companyId = await this.companies.getCompanyId();
      const row = buildDecisionLogRow(state, outcome);
      if (outcome.status === 'ERROR') {
        // A failed duplicate or retry must never replace a turn that completed
        // (two workers can race on one webhook event). ON CONFLICT DO NOTHING
        // first; only an earlier ERROR row is overwritten, a COMPLETED one just
        // counts the attempt.
        const created = await this.prisma.decisionLog.createMany({
          data: [{ ...row, companyId }],
          skipDuplicates: true,
        });
        if (!created.count) {
          const key = { companyId, eventId: row.eventId };
          await this.prisma.decisionLog.updateMany({
            where: { ...key, status: 'ERROR' },
            data: { ...row, attempt: { increment: 1 } },
          });
          await this.prisma.decisionLog.updateMany({
            where: { ...key, status: 'COMPLETED' },
            data: { attempt: { increment: 1 } },
          });
        }
        return;
      }
      // A retried event replaces the earlier attempt instead of adding a row.
      await this.prisma.decisionLog.upsert({
        where: { companyId_eventId: { companyId, eventId: row.eventId } },
        create: { ...row, companyId },
        update: { ...row, attempt: { increment: 1 } },
      });
    } catch (error) {
      this.logger.warn(
        `decision log not saved for event=${state.meta.eventId}: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    try {
      const { count } = await this.prisma.decisionLog.deleteMany({
        where: {
          createdAt: { lt: new Date(now - this.retentionDays * DAY_MS) },
        },
      });
      if (count) this.logger.log(`purged ${count} expired decision log(s)`);
      return count;
    } catch (error) {
      this.logger.warn(
        `decision log purge failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return 0;
    }
  }
}

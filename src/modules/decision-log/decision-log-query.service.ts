import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompanyService } from '../admin/company/company.service';
import type {
  DecisionLogSummaryQueryDto,
  ListDecisionLogsQueryDto,
} from './dto/decision-log-query.dto';

/** An unbounded summary would scan the whole log; default to the last week. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const listSelect = {
  id: true,
  createdAt: true,
  channel: true,
  eventId: true,
  userId: true,
  conversationId: true,
  messageType: true,
  inputText: true,
  action: true,
  answerType: true,
  answerMode: true,
  retrievalRoute: true,
  topVectorSimilarity: true,
  topScore: true,
  isFallback: true,
  fallbackReason: true,
  handoffRequested: true,
  responseSource: true,
  llmCallCount: true,
  latencyMs: true,
  status: true,
} satisfies Prisma.DecisionLogSelect;

/** Admin reads of the decision log, always scoped to the admin's company. */
@Injectable()
export class DecisionLogQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompanyService,
  ) {}

  async list(query: ListDecisionLogsQueryDto) {
    const companyId = await this.companies.getCompanyId();
    // No default window here: finding one event, user or conversation must
    // work for any row still within retention. (createdAt, id) is indexed.
    const where: Prisma.DecisionLogWhereInput = {
      companyId,
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.answerType ? { answerType: query.answerType } : {}),
      ...(query.isFallback !== undefined
        ? { isFallback: query.isFallback }
        : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.eventId ? { eventId: query.eventId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.fallbackReason ? { fallbackReason: query.fallbackReason } : {}),
    };
    if (query.cursor) {
      const cursor = await this.prisma.decisionLog.findFirst({
        where: { id: query.cursor, companyId },
        select: { createdAt: true, id: true },
      });
      if (!cursor) throw new NotFoundException('Decision log cursor not found');
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.decisionLog.findMany({
      where,
      select: listSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? items[items.length - 1].id : null,
    };
  }

  async get(id: string) {
    const companyId = await this.companies.getCompanyId();
    const row = await this.prisma.decisionLog.findFirst({
      where: { id, companyId },
    });
    if (!row) throw new NotFoundException('Decision log not found');
    return row;
  }

  /**
   * Aggregates for tuning: what answered, why it fell back, and how the best
   * vector similarity is distributed for answered vs fallback turns (the
   * input for choosing confidence thresholds).
   */
  async summary(query: DecisionLogSummaryQueryDto) {
    const companyId = await this.companies.getCompanyId();
    const where = this.window(companyId, query);
    const [total, byAnswerType, byFallbackReason, byAction, totals] =
      await Promise.all([
        this.prisma.decisionLog.count({ where }),
        this.prisma.decisionLog.groupBy({
          by: ['answerType', 'isFallback'],
          where,
          _count: { _all: true },
          _avg: { topVectorSimilarity: true, latencyMs: true },
        }),
        this.prisma.decisionLog.groupBy({
          by: ['fallbackReason'],
          where: { ...where, isFallback: true },
          _count: { _all: true },
        }),
        this.prisma.decisionLog.groupBy({
          by: ['action'],
          where,
          _count: { _all: true },
        }),
        this.prisma.decisionLog.aggregate({
          where,
          _sum: {
            llmCallCount: true,
            llmInputTokens: true,
            llmOutputTokens: true,
          },
          _avg: { latencyMs: true },
        }),
      ]);
    const fallbacks = byAnswerType
      .filter((row) => row.isFallback)
      .reduce((sum, row) => sum + row._count._all, 0);
    return {
      window: { from: where.createdAt.gte, to: where.createdAt.lte ?? null },
      total,
      fallbacks,
      fallbackRate: total ? fallbacks / total : 0,
      byAnswerType: byAnswerType.map((row) => ({
        answerType: row.answerType,
        isFallback: row.isFallback,
        count: row._count._all,
        avgTopVectorSimilarity: row._avg.topVectorSimilarity,
        avgLatencyMs: row._avg.latencyMs,
      })),
      byFallbackReason: byFallbackReason
        .map((row) => ({ reason: row.fallbackReason, count: row._count._all }))
        .sort((a, b) => b.count - a.count),
      byAction: byAction
        .map((row) => ({ action: row.action, count: row._count._all }))
        .sort((a, b) => b.count - a.count),
      llm: {
        calls: totals._sum.llmCallCount ?? 0,
        inputTokens: totals._sum.llmInputTokens ?? 0,
        outputTokens: totals._sum.llmOutputTokens ?? 0,
      },
      avgLatencyMs: totals._avg.latencyMs,
      similarityHistogram: await this.histogram(companyId, where, query.bucket),
    };
  }

  private async histogram(
    companyId: string,
    where: ReturnType<DecisionLogQueryService['window']>,
    bucket: number,
  ) {
    const range = where.createdAt;
    const rows = await this.prisma.$queryRaw<
      { bucket: number; total: bigint; fallbacks: bigint }[]
    >(Prisma.sql`
      SELECT (floor("topVectorSimilarity" / ${bucket}) * ${bucket})::float8 AS bucket,
        count(*) AS total,
        count(*) FILTER (WHERE "isFallback") AS fallbacks
      FROM "decisionLogs"
      WHERE "companyId" = ${companyId}::uuid
        AND "topVectorSimilarity" IS NOT NULL
        AND "createdAt" >= ${range.gte}
        ${range.lte ? Prisma.sql`AND "createdAt" <= ${range.lte}` : Prisma.empty}
        ${where.answerType ? Prisma.sql`AND "answerType" = ${where.answerType}` : Prisma.empty}
      GROUP BY 1 ORDER BY 1`);
    return rows.map((row) => ({
      from: Number(row.bucket.toFixed(4)),
      to: Number((row.bucket + bucket).toFixed(4)),
      total: Number(row.total),
      fallbacks: Number(row.fallbacks),
    }));
  }

  private window(
    companyId: string,
    query: {
      from?: Date;
      to?: Date;
      answerType?: string;
      isFallback?: boolean;
    },
  ): {
    companyId: string;
    createdAt: { gte: Date; lte?: Date };
    answerType?: string;
    isFallback?: boolean;
  } {
    return {
      companyId,
      createdAt: {
        gte: query.from ?? new Date(Date.now() - DEFAULT_WINDOW_MS),
        ...(query.to ? { lte: query.to } : {}),
      },
      ...(query.answerType ? { answerType: query.answerType } : {}),
      ...(query.isFallback !== undefined
        ? { isFallback: query.isFallback }
        : {}),
    };
  }
}

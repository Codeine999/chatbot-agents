import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UsageKind } from '../../../generated/prisma/client';
import {
  EMBEDDING_ADAPTER,
  EMBEDDING_DIMENSIONS,
} from '../../../infra/embedding/embedding-adapter.interface';
import type { EmbeddingAdapter } from '../../../infra/embedding/embedding-adapter.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  DIRECT_IMMEDIALY,
  MIN_CONTEXT_SCORE,
} from '../../chatbot/constants/knowledge-routing.constants';
import { AiPricingService } from '../../usage/billing/ai-pricing.service';
import { buildAnswerPatternDocument } from './answer-pattern-document';
import { AnswerPatternVectorRepository } from './answer-pattern-vector.repository';
import type { VectorCoverageRow } from './answer-pattern-vector.repository';
import { EmbeddingService } from './embedding.service';

type CoverageStatus = 'indexed' | 'missing' | 'mismatch' | 'stale';

type UsageTotals = {
  calls: number;
  failures: number;
  inputTokens: number;
  chargedCredit: number;
  costThb: number;
};

/**
 * Back-office operations on the embedding index.
 *
 * Everything here reads or repairs what `EmbeddingHealthService` reports on:
 * health says *that* retrieval is broken, these routes say *which* patterns
 * and let an owner fix them without re-embedding the whole knowledge base.
 */
@Injectable()
export class EmbeddingAdminService {
  private readonly logger = new Logger(EmbeddingAdminService.name);

  constructor(
    @Inject(EMBEDDING_ADAPTER)
    private readonly adapter: EmbeddingAdapter,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pricingService: AiPricingService,
    private readonly vectors: AnswerPatternVectorRepository,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * The identity every stored vector must agree with. `apiKeyConfigured` is a
   * boolean on purpose — the key itself is never echoed.
   */
  async getConfig() {
    const pricing = await this.pricingService.findActivePricing(
      this.adapter.provider,
      this.adapter.model,
    );

    return {
      provider: this.adapter.provider,
      model: this.adapter.model,
      dimensions: EMBEDDING_DIMENSIONS,
      apiKeyConfigured: Boolean(
        this.configService.get<string>('GEMINI_API_KEY')?.trim(),
      ),
      requestTimeoutMs: Number(
        this.configService.get<string>('GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS') ??
          8_000,
      ),
      /** Fixed at compile time — see `EmbeddingModule` for why. */
      switchable: false,
      pricing: pricing
        ? {
            id: pricing.id,
            inputCreditPerMillTokens:
              pricing.inputCreditPerMillTokens.toNumber(),
            inputCostThbPerMillTokens:
              pricing.inputCostThbPerMillTokens.toNumber(),
          }
        : null,
      thresholds: {
        minContextScore: MIN_CONTEXT_SCORE,
        directImmediately: DIRECT_IMMEDIALY,
      },
    };
  }

  async getCoverage(status: 'all' | 'indexed' | 'missing' | 'mismatch') {
    const rows = await this.vectors.coverage();
    const items = rows
      .filter((row) => row.patternActive)
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: this.coverageStatus(row),
        embeddingModel: row.embeddingModel,
        patternUpdatedAt: row.patternUpdatedAt,
        vectorUpdatedAt: row.vectorUpdatedAt,
      }));

    const summary = {
      activePatterns: items.length,
      indexed: items.filter((item) => item.status === 'indexed').length,
      missing: items.filter((item) => item.status === 'missing').length,
      mismatch: items.filter((item) => item.status === 'mismatch').length,
      stale: items.filter((item) => item.status === 'stale').length,
    };

    return {
      model: this.adapter.model,
      summary,
      items:
        status === 'all'
          ? items
          : items.filter((item) =>
              status === 'indexed'
                ? item.status === 'indexed' || item.status === 'stale'
                : item.status === status,
            ),
    };
  }

  /**
   * Indexes only what vector search cannot currently reach. A full reindex
   * lives on the answer-pattern route and re-embeds every row; this one pays
   * for the gap, which is the usual case after adding patterns or renaming
   * the model.
   */
  async backfill(
    options: { force?: boolean; limit?: number } = {},
    adminMemberId?: string,
  ) {
    const rows = await this.vectors.coverage();
    const candidates = rows.filter((row) => {
      if (!row.patternActive) return false;
      return options.force ? true : this.coverageStatus(row) !== 'indexed';
    });
    const targets = options.limit
      ? candidates.slice(0, options.limit)
      : candidates;

    const failed: Array<{ id: string; title: string; reason: string }> = [];
    let indexed = 0;

    for (const target of targets) {
      try {
        const pattern = await this.prisma.answerPattern.findUnique({
          where: { id: target.id },
        });

        if (!pattern) {
          failed.push({
            id: target.id,
            title: target.title,
            reason: 'Pattern disappeared during backfill',
          });
          continue;
        }

        const embedding = await this.embeddingService.embedDocument(
          buildAnswerPatternDocument(pattern),
          { adminMemberId },
        );

        await this.vectors.upsert(
          this.prisma,
          pattern.id,
          embedding.values,
          embedding.model,
          pattern.active,
        );
        indexed += 1;
      } catch (error) {
        this.logger.warn(
          `[EmbeddingBackfill] ${target.id} failed: ${String(error)}`,
        );
        failed.push({
          id: target.id,
          title: target.title,
          reason: String(error),
        });
      }
    }

    return {
      model: this.adapter.model,
      scanned: rows.length,
      targeted: targets.length,
      remaining: candidates.length - targets.length,
      indexed,
      failed,
    };
  }

  /**
   * Embeds arbitrary text and reports the vector's shape rather than the
   * vector. The norm is the useful signal: a well-formed Gemini embedding is
   * L2-normalized to ~1, so a value far off that means the output was
   * truncated or rescaled before it reached the column.
   */
  async preview(
    input: {
      text: string;
      task: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT';
      preview: number;
    },
    adminMemberId?: string,
  ) {
    const startedAt = Date.now();
    const embedding =
      input.task === 'RETRIEVAL_DOCUMENT'
        ? await this.embeddingService.embedDocument(input.text, {
            adminMemberId,
          })
        : await this.embeddingService.embedQuery(input.text, {
            adminMemberId,
          });

    const values = embedding.values;
    const norm = Math.sqrt(
      values.reduce((total, value) => total + value * value, 0),
    );

    return {
      provider: this.adapter.provider,
      model: embedding.model,
      task: input.task,
      latencyMs: Date.now() - startedAt,
      dimensions: values.length,
      dimensionsExpected: EMBEDDING_DIMENSIONS,
      norm,
      allFinite: values.every((value) => Number.isFinite(value)),
      usage: embedding.usage,
      usageEstimated: embedding.usageEstimated,
      values: values.slice(0, input.preview),
    };
  }

  /**
   * The chatbot's own vector search, run by hand. Scores come back unmerged
   * with keyword candidates, so `scoreBand` indicates how `decide()` would
   * read this half of the evidence, not what the router would finally do.
   */
  async search(
    input: { query: string; limit: number },
    adminMemberId?: string,
  ) {
    const startedAt = Date.now();
    const embedding = await this.embeddingService.embedQuery(input.query, {
      adminMemberId,
    });
    const candidates = await this.vectors.search(
      embedding.values,
      embedding.model,
      input.limit,
    );

    return {
      query: input.query,
      model: embedding.model,
      latencyMs: Date.now() - startedAt,
      thresholds: {
        minContextScore: MIN_CONTEXT_SCORE,
        directImmediately: DIRECT_IMMEDIALY,
      },
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        category: candidate.category,
        intentKey: candidate.intentKey,
        score: Number(candidate.score),
        scoreBand: this.scoreBand(Number(candidate.score)),
      })),
    };
  }

  /**
   * Spend and failure rate for `UsageKind.EMBEDDING` over a recent window.
   *
   * Broken down by `scopeKey` because the two directions answer different
   * questions: `document` is indexing work an admin triggered and is bounded
   * by the size of the knowledge base, while `query` scales with customer
   * traffic. A bill that grows unexpectedly is only diagnosable once the two
   * are separated — `kind` alone cannot tell them apart.
   */
  async getUsage(input: { days: number; limit: number }) {
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1_000);
    const window = { kind: UsageKind.EMBEDDING, createdAt: { gte: since } };

    const [events, byScope] = await Promise.all([
      this.prisma.aiUsageEvent.findMany({
        where: window,
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        select: {
          id: true,
          createdAt: true,
          model: true,
          scopeKey: true,
          adminMemberId: true,
          lineMemberId: true,
          conversationId: true,
          status: true,
          errorCode: true,
          inputTokens: true,
          chargedCredit: true,
          costThb: true,
          latencyMs: true,
        },
      }),
      this.prisma.aiUsageEvent.groupBy({
        by: ['scopeKey', 'status'],
        where: window,
        _count: { _all: true },
        _sum: { inputTokens: true, chargedCredit: true, costThb: true },
      }),
    ]);

    const scopes = new Map<string, UsageTotals>();
    const totals = this.emptyTotals();

    for (const row of byScope) {
      // Rows written before `scopeKey` existed carry null; they are real spend
      // and must still be counted, just not attributed to a direction.
      const key = row.scopeKey ?? 'unknown';
      const scope = scopes.get(key) ?? this.emptyTotals();
      const failures = row.status === 'success' ? 0 : row._count._all;

      scopes.set(key, this.addTotals(scope, row, failures));
      Object.assign(totals, this.addTotals(totals, row, failures));
    }

    return {
      since: since.toISOString(),
      totals,
      byScope: Object.fromEntries(scopes),
      events: events.map((event) => ({
        ...event,
        chargedCredit: this.toNumber(event.chargedCredit),
        costThb: this.toNumber(event.costThb),
      })),
    };
  }

  private emptyTotals(): UsageTotals {
    return {
      calls: 0,
      failures: 0,
      inputTokens: 0,
      chargedCredit: 0,
      costThb: 0,
    };
  }

  private addTotals(
    current: UsageTotals,
    row: {
      _count: { _all: number };
      _sum: {
        inputTokens: number | null;
        chargedCredit: Prisma.Decimal | null;
        costThb: Prisma.Decimal | null;
      };
    },
    failures: number,
  ): UsageTotals {
    return {
      calls: current.calls + row._count._all,
      failures: current.failures + failures,
      inputTokens: current.inputTokens + (row._sum.inputTokens ?? 0),
      chargedCredit:
        current.chargedCredit + this.toNumber(row._sum.chargedCredit),
      costThb: current.costThb + this.toNumber(row._sum.costThb),
    };
  }

  private coverageStatus(row: VectorCoverageRow): CoverageStatus {
    if (!row.embeddingModel || !row.vectorActive) return 'missing';
    if (row.embeddingModel !== this.adapter.model) return 'mismatch';
    if (
      row.vectorUpdatedAt &&
      row.patternUpdatedAt.getTime() > row.vectorUpdatedAt.getTime()
    ) {
      return 'stale';
    }
    return 'indexed';
  }

  private scoreBand(score: number): 'DIRECT' | 'RAG' | 'LOW_CONFIDENCE' {
    if (score < MIN_CONTEXT_SCORE) return 'LOW_CONFIDENCE';
    return score >= DIRECT_IMMEDIALY ? 'DIRECT' : 'RAG';
  }

  private toNumber(value: Prisma.Decimal | null): number {
    return value ? value.toNumber() : 0;
  }
}

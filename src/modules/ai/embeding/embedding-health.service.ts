import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EMBEDDING_ADAPTER,
  EMBEDDING_DIMENSIONS,
} from '../../../infra/embedding/embedding-adapter.interface';
import type { EmbeddingAdapter } from '../../../infra/embedding/embedding-adapter.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../../admin/company/company.service';
import {
  DIRECT_IMMEDIALY,
  MIN_CONTEXT_SCORE,
} from '../../chatbot/constants/knowledge-routing.constants';
import { AiPricingService } from '../../usage/billing/ai-pricing.service';
import { AnswerPatternVectorRepository } from './answer-pattern-vector.repository';
import type { VectorCoverageRow } from './answer-pattern-vector.repository';
import { EmbeddingService } from './embedding.service';
import {
  BillingGate,
  ConfigGate,
  CoverageGate,
  EmbeddingHealthReport,
  EmbeddingHealthStatus,
  ProviderGate,
  RoundTripGate,
} from './types/embeding.type';

const CANARY_CANDIDATE_LIMIT = 3;

@Injectable()
export class EmbeddingHealthService {
  private readonly logger = new Logger(EmbeddingHealthService.name);

  constructor(
    @Inject(EMBEDDING_ADAPTER)
    private readonly adapter: EmbeddingAdapter,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
    private readonly pricingService: AiPricingService,
    private readonly vectors: AnswerPatternVectorRepository,
    private readonly embeddingService: EmbeddingService,
  ) {}

  async check(
    options: { deep?: boolean; query?: string; adminMemberId?: string } = {},
  ): Promise<EmbeddingHealthReport> {
    const deep = options.deep ?? false;
    const config = this.checkConfig();
    const [billing, coverageRows] = await Promise.all([
      this.checkBilling(),
      this.vectors.coverage(),
    ]);
    const coverage = this.checkCoverage(coverageRows);

    let provider: ProviderGate | null = null;
    let roundTrip: RoundTripGate | null = null;

    if (deep) {
      const probe = await this.probe(
        coverageRows,
        options.query,
        options.adminMemberId,
      );
      provider = probe.provider;
      roundTrip = probe.roundTrip;
    }

    const gates = { config, billing, coverage, provider, roundTrip };

    return {
      status: this.resolveStatus(gates),
      checkedAt: new Date().toISOString(),
      deep,
      issues: this.collectIssues(gates),
      ...gates,
    };
  }

  private checkConfig(): ConfigGate {
    const apiKeyConfigured = Boolean(
      this.configService.get<string>('GEMINI_API_KEY')?.trim(),
    );

    return {
      ok: apiKeyConfigured,
      provider: this.adapter.provider,
      model: this.adapter.model,
      dimensions: EMBEDDING_DIMENSIONS,
      apiKeyConfigured,
      requestTimeoutMs: Number(
        this.configService.get<string>('GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS') ??
          8_000,
      ),
      reason: apiKeyConfigured ? undefined : 'GEMINI_API_KEY is not configured',
    };
  }

  private async checkBilling(): Promise<BillingGate> {
    const pricing = await this.pricingService.findActivePricing(
      this.adapter.provider,
      this.adapter.model,
    );
    const wallet = await this.findWallet();

    const walletCredit = wallet ? wallet.balance : null;
    const reservedCredit = wallet ? wallet.reserved : null;
    const availableCredit =
      walletCredit === null || reservedCredit === null
        ? null
        : walletCredit - reservedCredit;

    const pricingActive = Boolean(
      pricing && pricing.inputCreditPerMillTokens.greaterThan(0),
    );
    const reason = !pricingActive
      ? `No active billable pricing for ${this.adapter.provider}/${this.adapter.model}`
      : !wallet
        ? 'No credit wallet for this company'
        : (availableCredit ?? 0) <= 0
          ? 'Wallet has no credit available'
          : undefined;

    return {
      ok: !reason,
      pricingActive,
      pricingId: pricing?.id ?? null,
      inputCreditPerMillTokens: pricing
        ? pricing.inputCreditPerMillTokens.toNumber()
        : null,
      walletCredit,
      reservedCredit,
      availableCredit,
      reason,
    };
  }

  private async findWallet(): Promise<{
    balance: number;
    reserved: number;
  } | null> {
    try {
      const companyId = await this.companyService.getCompanyId();
      const wallet = await this.prisma.creditWallet.findUnique({
        where: { companyId },
        select: { balanceCredit: true, reservedCredit: true, active: true },
      });

      if (!wallet || !wallet.active) return null;

      return {
        balance: wallet.balanceCredit.toNumber(),
        reserved: wallet.reservedCredit.toNumber(),
      };
    } catch (error) {
      this.logger.warn(
        `[EmbeddingHealth] wallet lookup failed: ${String(error)}`,
      );
      return null;
    }
  }

  private checkCoverage(rows: VectorCoverageRow[]): CoverageGate {
    const model = this.adapter.model;
    const active = rows.filter((row) => row.patternActive);
    const models = new Map<string, number>();

    let indexed = 0;
    let missing = 0;
    let modelMismatch = 0;
    let staleVectors = 0;

    for (const row of active) {
      if (row.embeddingModel) {
        models.set(
          row.embeddingModel,
          (models.get(row.embeddingModel) ?? 0) + 1,
        );
      }

      if (!row.embeddingModel || !row.vectorActive) {
        missing += 1;
        continue;
      }

      if (row.embeddingModel !== model) {
        modelMismatch += 1;
        continue;
      }

      indexed += 1;

      if (
        row.vectorUpdatedAt &&
        row.patternUpdatedAt.getTime() > row.vectorUpdatedAt.getTime()
      ) {
        staleVectors += 1;
      }
    }

    const reason =
      indexed === 0
        ? 'No active pattern is reachable by vector search'
        : missing > 0 || modelMismatch > 0
          ? `${missing} missing, ${modelMismatch} indexed under another model`
          : staleVectors > 0
            ? `${staleVectors} vectors older than their pattern`
            : undefined;

    return {
      ok: indexed === active.length && active.length > 0 && staleVectors === 0,
      activePatterns: active.length,
      indexed,
      missing,
      modelMismatch,
      staleVectors,
      models: [...models].map(([name, count]) => ({ model: name, count })),
      reason,
    };
  }

  private async probe(
    rows: VectorCoverageRow[],
    override?: string,
    adminMemberId?: string,
  ): Promise<{ provider: ProviderGate; roundTrip: RoundTripGate }> {
    const canary = override ? { query: override } : await this.pickCanary(rows);

    if (!canary) {
      return {
        provider: this.failedProvider(0, 'Skipped: nothing indexed to probe'),
        roundTrip: this.failedRoundTrip('', 'No indexed pattern to probe with'),
      };
    }

    const startedAt = Date.now();

    try {
      const embedding = await this.embeddingService.embedQuery(canary.query, {
        adminMemberId,
      });
      const latencyMs = Date.now() - startedAt;
      const dimensionsOk = embedding.values.length === EMBEDDING_DIMENSIONS;

      const provider: ProviderGate = {
        ok: dimensionsOk,
        model: embedding.model,
        dimensions: embedding.values.length,
        latencyMs,
        inputTokens: embedding.usage.inputTokens,
        usageEstimated: embedding.usageEstimated,
        reason: dimensionsOk
          ? undefined
          : `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.values.length}`,
      };

      const candidates = await this.vectors.search(
        embedding.values,
        embedding.model,
        CANARY_CANDIDATE_LIMIT,
      );

      return {
        provider,
        roundTrip: this.evaluateRoundTrip(canary, candidates),
      };
    } catch (error) {
      const reason = String(error);
      this.logger.warn(`[EmbeddingHealth] probe failed: ${reason}`);

      return {
        provider: this.failedProvider(Date.now() - startedAt, reason),
        roundTrip: this.failedRoundTrip(canary.query, reason),
      };
    }
  }

  /**
   * The highest-priority indexed pattern, asked in its own words. Using a
   * stored question example means the expected winner is known, which is what
   * separates "the index answered" from "the index answered correctly".
   */
  private async pickCanary(
    rows: VectorCoverageRow[],
  ): Promise<{ query: string; patternId: string; title: string } | undefined> {
    const indexed = rows.find(
      (row) =>
        row.patternActive &&
        row.vectorActive === true &&
        row.embeddingModel === this.adapter.model,
    );

    if (!indexed) return undefined;

    const pattern = await this.prisma.answerPattern.findUnique({
      where: { id: indexed.id },
      select: { id: true, title: true, questionExamples: true },
    });

    if (!pattern) return undefined;

    return {
      query: pattern.questionExamples[0]?.trim() || pattern.title,
      patternId: pattern.id,
      title: pattern.title,
    };
  }

  private evaluateRoundTrip(
    canary: { query: string; patternId?: string; title?: string },
    candidates: Array<{ id: string; title: string; score: number }>,
  ): RoundTripGate {
    const top = candidates[0];
    const topScore = top ? Number(top.score) : null;
    const scoreBand = this.scoreBand(topScore);
    const matchedExpected = canary.patternId
      ? top?.id === canary.patternId
      : true;
    const aboveThreshold = topScore !== null && topScore >= MIN_CONTEXT_SCORE;

    return {
      ok: Boolean(top) && matchedExpected && aboveThreshold,
      query: canary.query,
      expectedPatternId: canary.patternId,
      expectedTitle: canary.title,
      candidates: candidates.length,
      topPatternId: top?.id ?? null,
      topTitle: top?.title ?? null,
      topScore,
      scoreBand,
      reason: !top
        ? 'Vector search returned no candidate'
        : !matchedExpected
          ? `Expected "${canary.title}" to rank first, got "${top.title}"`
          : !aboveThreshold
            ? `Top score ${topScore?.toFixed(3)} is below MIN_CONTEXT_SCORE ${MIN_CONTEXT_SCORE}`
            : undefined,
    };
  }

  /**
   * Vector-only band, using the thresholds `decide()` applies. It is an
   * indicator rather than a verdict: the real decision also sees keyword
   * candidates, exact-match detection and the runner-up gap.
   */
  private scoreBand(score: number | null): RoundTripGate['scoreBand'] {
    if (score === null || score < MIN_CONTEXT_SCORE) return 'LOW_CONFIDENCE';
    return score >= DIRECT_IMMEDIALY ? 'DIRECT' : 'RAG';
  }

  private failedProvider(latencyMs: number, reason: string): ProviderGate {
    return {
      ok: false,
      model: this.adapter.model,
      dimensions: null,
      latencyMs,
      inputTokens: null,
      usageEstimated: null,
      reason,
    };
  }

  private failedRoundTrip(query: string, reason: string): RoundTripGate {
    return {
      ok: false,
      query,
      candidates: 0,
      topPatternId: null,
      topTitle: null,
      topScore: null,
      scoreBand: 'LOW_CONFIDENCE',
      reason,
    };
  }

  /**
   * `down` means no question can be answered from the knowledge base at all;
   * `degraded` means retrieval still runs but on an index that is incomplete
   * or returns the wrong entry — the state that produces confidently wrong
   * answers rather than fallbacks, so it must never report as healthy.
   */
  private resolveStatus(gates: {
    config: ConfigGate;
    billing: BillingGate;
    coverage: CoverageGate;
    provider: ProviderGate | null;
    roundTrip: RoundTripGate | null;
  }): EmbeddingHealthStatus {
    if (
      !gates.config.ok ||
      !gates.billing.ok ||
      gates.coverage.indexed === 0 ||
      gates.provider?.ok === false
    ) {
      return 'down';
    }

    if (!gates.coverage.ok || gates.roundTrip?.ok === false) {
      return 'degraded';
    }

    return 'ok';
  }

  private collectIssues(gates: {
    config: ConfigGate;
    billing: BillingGate;
    coverage: CoverageGate;
    provider: ProviderGate | null;
    roundTrip: RoundTripGate | null;
  }): string[] {
    return [
      gates.config.reason,
      gates.billing.reason,
      gates.coverage.reason,
      gates.provider?.reason,
      gates.roundTrip?.reason,
    ].filter((reason): reason is string => Boolean(reason));
  }
}

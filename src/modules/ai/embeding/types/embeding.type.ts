export type EmbeddingHealthStatus = 'ok' | 'degraded' | 'down';

export type EmbeddingHealthReport = {
  status: EmbeddingHealthStatus;
  checkedAt: string;
  deep: boolean;
  issues: string[];
  config: ConfigGate;
  billing: BillingGate;
  coverage: CoverageGate;
  provider: ProviderGate | null;
  roundTrip: RoundTripGate | null;
};

export type ConfigGate = {
  ok: boolean;
  provider: string;
  model: string;
  dimensions: number;
  apiKeyConfigured: boolean;
  requestTimeoutMs: number;
  reason?: string;
};

export type BillingGate = {
  ok: boolean;
  pricingActive: boolean;
  pricingId: string | null;
  inputCreditPerMillTokens: number | null;
  walletCredit: number | null;
  reservedCredit: number | null;
  availableCredit: number | null;
  reason?: string;
};

export type CoverageGate = {
  ok: boolean;
  activePatterns: number;
  indexed: number;
  missing: number;
  modelMismatch: number;
  staleVectors: number;
  models: Array<{ model: string; count: number }>;
  reason?: string;
};

export type ProviderGate = {
  ok: boolean;
  model: string;
  dimensions: number | null;
  latencyMs: number;
  inputTokens: number | null;
  usageEstimated: boolean | null;
  reason?: string;
};

export type RoundTripGate = {
  ok: boolean;
  query: string;
  /** Set when the canary was chosen from the index, absent for a manual query. */
  expectedPatternId?: string;
  expectedTitle?: string;
  candidates: number;
  topPatternId: string | null;
  topTitle: string | null;
  topScore: number | null;
  scoreBand: 'DIRECT' | 'RAG' | 'LOW_CONFIDENCE';
  reason?: string;
};

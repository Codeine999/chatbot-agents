import type {
  KnowledgeRetrievalResult,
  RouteDecision,
} from '../../chatbot/shared/types/chat.types';

/** What kind of answer the turn produced, for grouping in analysis. */
export const DECISION_ANSWER_TYPES = [
  'KNOWLEDGE',
  'MICRO_KNOWLEDGE',
  'MIXED_KNOWLEDGE',
  'PRODUCT',
  'GENERAL',
  'IMAGE',
  'RULE',
  'MENU',
  'REGISTRATION',
  'HANDOFF',
  'SYSTEM',
] as const;
export type DecisionAnswerType = (typeof DECISION_ANSWER_TYPES)[number];

/** Mirrors the Prisma `MessageChannel` enum. */
export const DECISION_CHANNELS = [
  'LINE',
  'FACEBOOK',
  'INSTAGRAM',
  'APPLICATION',
  'TIKTOK',
  'SHOPEE',
  'TELEGRAM',
  'ANOTHER',
] as const;
export type DecisionChannel = (typeof DECISION_CHANNELS)[number];

/** How the chatbot received the message. */
export type DecisionMessageType = 'text' | 'image' | 'sticker';

/** Pipeline stages that may add a note; the order notes arrive in is the flow. */
export type DecisionStage =
  | 'inbound'
  | 'rule'
  | 'gate'
  | 'retrieval'
  | 'product'
  | 'classifier'
  | 'route'
  | 'answer'
  | 'llm'
  | 'handoff'
  | 'outcome';

export type DecisionNote = Readonly<{
  stage: DecisionStage;
  /** Milliseconds since the turn started. */
  atMs: number;
  data: Readonly<Record<string, unknown>>;
}>;

/** How the reply text was produced. */
export type DecisionAnswerOutcome = Readonly<{
  mode: string;
  fallbackReason?: string;
  /** `SOURCE:ID` of the evidence the reply was built from. */
  evidenceIds?: readonly string[];
  /** What the grounded model said the customer asked about. */
  askedAbout?: string;
  commerceTurnId?: string;
}>;

export type DecisionTraceMeta = Readonly<{
  channel: DecisionChannel;
  eventId: string;
  /** The channel's own user id (LINE userId, `app:<contactId>`). */
  userId: string;
  conversationId?: string;
  messageType: DecisionMessageType;
  /** The customer's text; redacted and truncated before it is stored. */
  input?: string;
}>;

/** Mutable per-turn state held in AsyncLocalStorage. */
export type DecisionTraceState = {
  readonly meta: DecisionTraceMeta;
  readonly startedAt: number;
  readonly notes: DecisionNote[];
  /** Last stage noted; labels the LLM calls made while it runs. */
  stage?: DecisionStage;
  /** When the reply was produced, before it was saved and delivered. */
  repliedAt?: number;
  route?: RouteDecision;
  retrieval?: KnowledgeRetrievalResult;
  answer?: DecisionAnswerOutcome;
  handoffRequested: boolean;
  llm: { calls: number; inputTokens: number; outputTokens: number };
};

/** One retrieval candidate as stored in `DecisionLog.candidates`. */
export type DecisionCandidate = Readonly<{
  rank: number;
  ref: string;
  source: string;
  title: string;
  selected: boolean;
  /** RRF score; null for exact matches (a different scale) and product rows (no score). */
  fusedScore: number | null;
  lexicalScore: number | null;
  vectorSimilarity: number | null;
  matchTypes: readonly string[];
  exactMatch: boolean;
}>;

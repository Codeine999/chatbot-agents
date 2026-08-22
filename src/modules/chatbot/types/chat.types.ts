export type ChatIntent =
  | 'REGISTER'
  | 'GENERAL_QUESTION'
  | 'ANSWER_KNOWLEDGE'
  | 'REGISTER_HOW_TO'
  | 'CONTACT_ADMIN'
  | 'CANCEL'
  | 'UNKNOWN';

export type ChatAction =
  | 'CANCEL_SESSION'
  | 'CONTINUE_REGISTER'
  | 'START_REGISTER'
  | 'CONTINUE_AI_CHAT'
  | 'START_AI_CHAT'
  | 'ANSWER_KNOWLEDGE'
  | 'GENERAL_QUESTION'
  | 'FALLBACK'
  | 'CONTACT_ADMIN'
  | 'DEFAULT';

export type IntentSource =
  | 'SESSION'
  | 'RULE'
  | 'CACHE'
  | 'DATABASE'
  | 'EMBEDDING'
  | 'AI';

export type IntentResult = {
  intent: ChatIntent;
  confidence: number;
  source: 'RULE';
  reason?: string;
};

export type AiIntentAnalysis = {
  intent: ChatIntent;
  confidence: number;
  standaloneQuery?: string;
};

export type LowConfidenceClassification = 'BUSINESS' | 'GENERAL';

export type LowConfidenceAnalysis = Readonly<{
  classification: LowConfidenceClassification;
  confidence: number;
  response?: string;
}>;

export type KnowledgeMatchType =
  | 'EXACT'
  | 'KEYWORD'
  | 'EMBEDDING'
  | 'HYBRID'
  | 'NONE';

export type KnowledgeRoute = 'DIRECT' | 'RAG' | 'LOW_CONFIDENCE';

export type KnowledgeRetrievalDiagnosis =
  | 'NONE'
  | 'MISSING_USER_INFORMATION'
  | 'MISSING_KNOWLEDGE_EVIDENCE'
  | 'AMBIGUOUS_RESULTS'
  | 'CONFLICTING_CANDIDATES'
  | 'COMPLEX_QUERY'
  | 'RETRIEVAL_ERROR';

export type KnowledgeRewriteStrategy =
  | 'NONE'
  | 'REWRITE'
  | 'EXPAND'
  | 'DECOMPOSE';

export type KnowledgeRetrievalAttempt = Readonly<{
  attempt: number;
  query: string;
  candidateCount: number;
  retrievalFailed: boolean;
}>;

export type KnowledgeRetrievalResult = Readonly<{
  route: KnowledgeRoute;
  matchType: KnowledgeMatchType;
  items: readonly KnowledgeItem[];
  selectedItems: readonly KnowledgeItem[];
  topScores: readonly number[];
  scoreGap: number | null;
  fallbackReason?: string;
  attemptCount?: number;
  attempts?: readonly KnowledgeRetrievalAttempt[];
  diagnosis?: KnowledgeRetrievalDiagnosis;
  rewriteStrategy?: KnowledgeRewriteStrategy;
  plannerUsedLlm?: boolean;
}>;

export type RouteDecision = {
  action: ChatAction;
  intent: ChatIntent;
  confidence: number;
  source: IntentSource;
  reason?: string;
  resolvedQuery?: string;
  retrieval?: KnowledgeRetrievalResult;
  generatedResponse?: string;
  businessFallback?: boolean;
  fallbackReason?: string;
};

export type ChatContextRole = 'user' | 'assistant';

export type ChatResponseSource =
  | 'SYSTEM'
  | 'RULE'
  | 'KNOWLEDGE'
  | 'AI'
  | 'REGISTRATION';

export type ChatContextMessage = Readonly<{
  role: ChatContextRole;
  text: string;
  source: 'USER' | ChatResponseSource;
  createdAt: number;
}>;

export type ChatContextPolicy = 'INCLUDE' | 'EXCLUDE' | 'CLEAR';

export type ChatResponse = Readonly<{
  text: string;
  source: ChatResponseSource;
  contextPolicy: ChatContextPolicy;
}>;

export type ChatRequest = LineAiUsageContext &
  Readonly<{
    userId: string;
    text: string;
    recentMessages?: readonly ChatContextMessage[];
  }>;

export type ImageChatRequest = LineAiUsageContext &
  Readonly<{
    userId: string;
    image: AiProviderImage;
    recentMessages?: readonly ChatContextMessage[];
  }>;

export type StickerChatRequest = LineAiUsageContext &
  Readonly<{
    userId: string;
    packageId: string;
    stickerId: string;
    text?: string;
    keywords?: readonly string[];
    recentMessages?: readonly ChatContextMessage[];
  }>;

/**
 * `userId`, `lineMemberId` and `conversationId` travel together so a billed
 * AI call can be attributed to the LINE thread that triggered it.
 */
export type AiRequestContext = LineAiUsageContext &
  Readonly<{
    recentMessages?: readonly ChatContextMessage[];
  }>;

export type KnowledgeAnswerContext = AiRequestContext &
  Readonly<{
    retrievalQuery?: string;
    retrieval?: KnowledgeRetrievalResult;
  }>;

export type AiAnswerResult = Readonly<{
  text: string;
  isFallback: boolean;
  insufficientContext?: boolean;
}>;

export type KnowledgeItem = {
  source: 'ANSWER_PATTERN' | 'SEMANTIC_CHUNK';
  id: string;
  title?: string;
  category?: string | null;
  content: string;
  answer?: string;
  score: number;
  metadata?: Record<string, unknown>;
};

import type { AiProviderImage } from '../../../ai-provider/types/ai-provider.types';
import type { LineAiUsageContext } from '../../usage/billing/ai-usage.types';

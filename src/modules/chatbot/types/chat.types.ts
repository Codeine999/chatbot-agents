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

export type IntentSource = 'SESSION' | 'RULE' | 'CACHE' | 'AI';

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

export type RouteDecision = {
  action: ChatAction;
  intent: ChatIntent;
  confidence: number;
  source: IntentSource;
  reason?: string;
  resolvedQuery?: string;
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

export type ChatRequest = Readonly<{
  userId: string;
  text: string;
  recentMessages?: readonly ChatContextMessage[];
}>;

export type AiRequestContext = Readonly<{
  userId?: string;
  recentMessages?: readonly ChatContextMessage[];
}>;

export type KnowledgeAnswerContext = AiRequestContext &
  Readonly<{
    retrievalQuery?: string;
  }>;

export type AiAnswerResult = Readonly<{
  text: string;
  isFallback: boolean;
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

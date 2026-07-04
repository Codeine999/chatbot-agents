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
  | 'CONTACT_ADMIN'
  | 'DEFAULT';

export type IntentSource = 'SESSION' | 'RULE' | 'AI';

export type IntentResult = {
  intent: ChatIntent;
  confidence: number;
  source: 'RULE';
  reason?: string;
};

export type AiIntentAnalysis = {
  intent: ChatIntent;
  confidence: number;
};

export type RouteDecision = {
  action: ChatAction;
  intent: ChatIntent;
  confidence: number;
  source: IntentSource;
  reason?: string;
};

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

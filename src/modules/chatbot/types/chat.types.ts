export type ChatIntent =
  | 'REGISTER'
  | 'AI_CHAT'
  | 'GENERAL_QUESTION'
  | 'REGISTER_HOW_TO'
  | 'CONTACT_ADMIN'
  | 'CHECK_STATUS'
  | 'CHECK_PAYMENT_STATUS'
  | 'CANCEL'
  | 'UNKNOWN';

export type ChatAction =
  | 'CANCEL_SESSION'
  | 'CONTINUE_REGISTER'
  | 'START_REGISTER'
  | 'CONTINUE_AI_CHAT'
  | 'START_AI_CHAT'
  | 'ANSWER_KNOWLEDGE'
  | 'CONTACT_ADMIN'
  | 'CHECK_STATUS'
  | 'ANSWER_GENERAL'
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
  needsKnowledgeSearch: boolean;
  needsBusinessData: boolean;
  entities: {
    name?: string;
    phone?: string;
    bankName?: string;
    bankAccount?: string;
    paymentRef?: string;
  };
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

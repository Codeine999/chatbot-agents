export type ConversationFlow =
  | 'REGISTER'
  | 'GENERAL_QUESTION'
  | 'CHECK_STATUS'
  | 'CONTACT_ADMIN';

export type ConversationStatus =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface ConversationSession<TData = Record<string, unknown>> {
  userId: string;
  flow: ConversationFlow;
  step: string; // for keep step generic
  status: ConversationStatus; //keep generic status after action
  data: TData; //generic data
}

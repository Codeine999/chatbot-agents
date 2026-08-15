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

export const ControlMode = {
  AI: 'AI',
  ADMIN: 'ADMIN',
  PAUSE: 'PAUSE',
} as const;

export type ControlMode = keyof typeof ControlMode;

export interface ConversationSession<TData = Record<string, unknown>> {
  userId: string;
  flow: ConversationFlow;
  step: string; // for keep step generic
  status: ConversationStatus; //keep generic status after action
  controlMode: ControlMode;
  /** Set true when this session needs a human admin — triggers an admin notification. */
  requiAdmin?: boolean;
  data: TData; //generic data
}
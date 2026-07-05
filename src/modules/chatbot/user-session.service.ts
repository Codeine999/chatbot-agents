import { Injectable } from '@nestjs/common';

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

export interface ConversationSession<TData = Record<string, any>> {
  userId: string;
  flow: ConversationFlow;
  step: string;
  status: ConversationStatus;
  data: TData;
}

@Injectable()
export class UserSessionService {
  private readonly sessions = new Map<string, ConversationSession>();

  get(userId: string): ConversationSession | undefined {
    return this.sessions.get(userId);
  }

  set(userId: string, session: ConversationSession) {
    this.sessions.set(userId, session);
  }

  clear(userId: string) {
    this.sessions.delete(userId);
  }
}




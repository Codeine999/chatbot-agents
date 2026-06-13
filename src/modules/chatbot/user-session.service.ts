import { Injectable } from '@nestjs/common';

export type ConversationFlow =
  | 'REGISTER'
  | 'CHECK_STATUS'
  | 'CONTACT_ADMIN'
  | 'GENERAL_QUESTION';

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

  get(userId: string): ConversationSession {
    const existing = this.sessions.get(userId);

    if (existing) {
      return existing;
    }

    const session: ConversationSession = {
      userId,
      flow: 'GENERAL_QUESTION',
      step: 'START',
      status: 'ACTIVE',
      data: {},
    };

    this.sessions.set(userId, session);
    return session;
  }

  set(userId: string, session: ConversationSession) {
    this.sessions.set(userId, session);
  }

  clear(userId: string) {
    this.sessions.delete(userId);
  }
  
}

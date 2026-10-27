import type { FastifyRequest } from 'fastify';

/** Set by AppClientGuard on every App Message request. */
export type AppCallerContext = Readonly<{
  /** Salted hash of the caller's IP; the address itself is never kept. */
  ipHash: string;
}>;

/** Set by AppSessionGuard once the bearer token is accepted. */
export type AppGuestContext = AppCallerContext &
  Readonly<{
    sessionId: string;
    contactId: string;
    companyId: string;
    expiresAt: Date;
  }>;

export type AppRequest = FastifyRequest & {
  appCaller?: AppCallerContext;
  appGuest?: AppGuestContext;
};

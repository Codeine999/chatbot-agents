import { z } from 'zod';

export const verifiedChannelIdentitySchema = z
  .object({
    channel: z.enum(['LINE', 'FACEBOOK', 'WEB']),
    connectionKey: z.string().min(1).max(100),
    externalUserId: z.string().min(1).max(255),
  })
  .strict();

/** Supplied by a verified channel worker/authenticated adapter, never an HTTP request body. */
export type VerifiedChannelIdentity = Readonly<
  z.infer<typeof verifiedChannelIdentitySchema>
>;

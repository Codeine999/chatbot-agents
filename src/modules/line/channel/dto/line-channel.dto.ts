import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const connectLineChannelSchema = z
  .object({
    channelId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, 'Channel ID must be digits')
      .optional(),
    /** Messaging API channel secret: 32 hex characters. */
    channelSecret: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{32}$/i, 'Channel secret must be 32 hex characters'),
    /** Long-lived channel access token. */
    accessToken: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^\S+$/, 'Access token must not contain spaces'),
  })
  .strict();

export class ConnectLineChannelDto extends createZodDto(
  connectLineChannelSchema,
) {}

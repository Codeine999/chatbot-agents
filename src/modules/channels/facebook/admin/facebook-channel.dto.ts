import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const connectFacebookChannelSchema = z
  .object({
    /** Meta app secret (App settings > Basic): 32 hex characters. */
    appSecret: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{32}$/i, 'App secret must be 32 hex characters'),
    /** Page access token with pages_messaging. */
    pageAccessToken: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .regex(/^\S+$/, 'Page access token must not contain spaces'),
  })
  .strict();

export class ConnectFacebookChannelDto extends createZodDto(
  connectFacebookChannelSchema,
) {}

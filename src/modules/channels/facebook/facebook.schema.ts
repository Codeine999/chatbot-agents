import { z } from 'zod';

/**
 * The parts of a Messenger Platform webhook the connector reads. Everything
 * else (delivery, read, reaction, referral, ...) passes through as unknown
 * keys and is dropped. https://developers.facebook.com/docs/messenger-platform/webhooks
 */
const messagingSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: z
    .object({
      mid: z.string().min(1),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      attachments: z.array(z.unknown()).optional(),
    })
    .optional(),
  postback: z
    .object({
      mid: z.string().optional(),
      title: z.string().optional(),
      payload: z.string().optional(),
    })
    .optional(),
});

export const facebookWebhookSchema = z.object({
  object: z.literal('page'),
  entry: z.array(
    z.object({
      id: z.string(),
      messaging: z.array(z.unknown()).optional(),
    }),
  ),
});

export const parseMessaging = (value: unknown) =>
  messagingSchema.safeParse(value);

/** Graph API error body: `{ error: { code, error_subcode } }`. */
export const graphErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});

export const graphSendResultSchema = z.object({
  message_id: z.string().optional(),
});

/** GET /<PSID>?fields=first_name,last_name,profile_pic */
export const graphProfileSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  name: z.string().optional(),
  profile_pic: z.string().url().optional(),
});

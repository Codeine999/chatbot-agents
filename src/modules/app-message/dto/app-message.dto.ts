import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { appMetadataSchema } from './app-metadata';

export const sendMessageSchema = z
  .object({
    /** Client-generated; resending the same id returns the first answer. */
    clientMessageId: z.string().uuid(),
    /** Raw text; length is checked against APP_TEXT_MAX_CHARS after sanitizing. */
    text: z.string().max(10_000),
    metadata: appMetadataSchema.optional(),
  })
  .strict();

export const listMessagesQuerySchema = z
  .object({
    after: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export class SendMessageDto extends createZodDto(sendMessageSchema) {}
export class ListMessagesQueryDto extends createZodDto(
  listMessagesQuerySchema,
) {}

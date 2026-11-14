import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const iso = z.string().max(40).optional();

/** Same shape as the LINE history query so the dashboard can share its code. */
export const listChannelMessagesQuerySchema = z
  .object({
    before: iso,
    after: iso,
    // Id of the message at `before`/`after`, for a tie-safe keyset.
    beforeId: z.string().uuid().optional(),
    afterId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const sendChannelAdminMessageSchema = z
  .object({
    text: z.string().max(5000),
    clientRequestId: z.string().uuid().optional(),
  })
  .strict();

export class ListChannelMessagesQueryDto extends createZodDto(
  listChannelMessagesQuerySchema,
) {}
export class SendChannelAdminMessageDto extends createZodDto(
  sendChannelAdminMessageSchema,
) {}

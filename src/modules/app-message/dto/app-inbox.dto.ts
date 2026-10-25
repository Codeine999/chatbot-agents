import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const iso = z.string().max(40).optional();

/** Same shape as the LINE history query so the dashboard can share its code. */
export const listAppMessagesQuerySchema = z
  .object({
    before: iso,
    after: iso,
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const sendAppAdminMessageSchema = z
  .object({
    text: z.string().max(5000),
    clientRequestId: z.string().uuid().optional(),
  })
  .strict();

export class ListAppMessagesQueryDto extends createZodDto(
  listAppMessagesQuerySchema,
) {}
export class SendAppAdminMessageDto extends createZodDto(
  sendAppAdminMessageSchema,
) {}

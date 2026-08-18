import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class NotificationIdParamDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
  }),
) {}

export class NotificationConversationParamDto extends createZodDto(
  z.object({
    conversationId: z.string().uuid(),
  }),
) {}

export class ListNotificationsQueryDto extends createZodDto(
  z.object({
    unreadOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  }),
) {}

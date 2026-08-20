import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class RoomIdParamDto extends createZodDto(
  z.object({
    roomId: z.string().uuid(),
  }),
) {}

export class CreateAdminChatRoomDto extends createZodDto(
  z.object({
    title: z.string().trim().min(1).max(255).optional(),
  }),
) {}

export class RenameAdminChatRoomDto extends createZodDto(
  z.object({
    title: z.string().trim().min(1).max(255),
  }),
) {}

export class SendAdminChatMessageDto extends createZodDto(
  z.object({
    /** Omit to start a new room; the title is derived from the first message. */
    roomId: z.string().uuid().optional(),
    text: z.string().trim().min(1).max(20_000),
  }),
) {}

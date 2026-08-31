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

/**
 * There is deliberately no `provider`/`model` here. The AI used for a
 * back-office turn is read from the stored `AiProviderSetting` (ADMIN scope);
 * a body naming a model is ignored rather than honoured, so an admin cannot
 * bill the shared wallet at a rate nobody published.
 */
export class SendAdminChatMessageDto extends createZodDto(
  z.object({
    /** Omit to start a new room; the title is derived from the first message. */
    roomId: z.string().uuid().optional(),
    text: z.string().trim().min(1).max(20_000),
  }),
) {}

export class AdminMemberIdParamDto extends createZodDto(
  z.object({
    adminMemberId: z.string().uuid(),
  }),
) {}

export class SetAdminAiBudgetDto extends createZodDto(
  z.object({
    /** Credit allowance; `null` means unlimited. */
    limitCredit: z
      .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,6})?$/)])
      .nullable(),
  }),
) {}

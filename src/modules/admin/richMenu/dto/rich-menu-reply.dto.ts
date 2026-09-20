import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MENU_REPLY_KEY_PATTERN } from '../../../../shared/richMenu/menu-postback';
import { RICH_MENU_REPLY_TEXT_MAX } from '../rich-menu.constants';

const replyFields = {
  /**
   * What the menu button carries (`menu=<key>`). It is part of a published
   * menu that customers already have on their phones, so it is chosen once and
   * then treated as permanent; renaming it orphans every live button using it.
   */
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      MENU_REPLY_KEY_PATTERN,
      'key must be lowercase letters, digits, hyphen or underscore (max 64)',
    ),

  /** The caption customers read, and the text a tap echoes into the chat. */
  label: z.string().trim().min(1).max(100),

  replyText: z.string().trim().min(1).max(RICH_MENU_REPLY_TEXT_MAX),

  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(1_000),
} as const;

export class CreateRichMenuReplyDto extends createZodDto(
  z.object({
    ...replyFields,
    active: replyFields.active.default(true),
    sortOrder: replyFields.sortOrder.default(0),
  }),
) {}

export class UpdateRichMenuReplyDto extends createZodDto(
  z
    .object({
      // `key` is deliberately absent: a published button cannot follow a rename.
      label: replyFields.label,
      replyText: replyFields.replyText,
      active: replyFields.active,
      sortOrder: replyFields.sortOrder,
    })
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      'At least one field is required',
    ),
) {}

export class RichMenuReplyIdParamDto extends createZodDto(
  z.object({ id: z.string().uuid() }),
) {}

export class ListRichMenuReplyQueryDto extends createZodDto(
  z.object({
    /** `'true'`/`'false'`, because a query string carries no booleans. */
    active: z.enum(['true', 'false']).optional(),
    search: z.string().trim().max(100).optional(),
  }),
) {}

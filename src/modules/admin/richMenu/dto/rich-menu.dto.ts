import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  RICH_MENU_BULK_MAX_USERS,
  RICH_MENU_MAX_AREAS,
  RICH_MENU_SIZES,
} from '../rich-menu.constants';

const label = z.string().trim().min(1).max(20);

/**
 * The action LINE fires for one tappable area. Field limits mirror the
 * Messaging API so an invalid menu is rejected here instead of by LINE.
 */
const postbackActionSchema = z.object({
  type: z.literal('postback'),
  label: label.optional(),
  data: z.string().trim().min(1).max(300),
  /** Echoed into the chat as if the user typed it. */
  displayText: z.string().trim().min(1).max(300).optional(),
  inputOption: z
    .enum(['closeRichMenu', 'openRichMenu', 'openKeyboard', 'openVoice'])
    .optional(),
  fillInText: z.string().trim().max(300).optional(),
});

const messageActionSchema = z.object({
  type: z.literal('message'),
  label: label.optional(),
  text: z.string().trim().min(1).max(300),
});

const uriActionSchema = z.object({
  type: z.literal('uri'),
  label: label.optional(),
  uri: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine(
      (value) => /^(https?|line|tel):/i.test(value),
      'uri must start with http, https, line or tel',
    ),
});

const datetimePickerActionSchema = z.object({
  type: z.literal('datetimepicker'),
  label: label.optional(),
  data: z.string().trim().min(1).max(300),
  mode: z.enum(['date', 'time', 'datetime']),
  initial: z.string().trim().max(50).optional(),
  max: z.string().trim().max(50).optional(),
  min: z.string().trim().max(50).optional(),
});

/** Swaps the user to another rich menu by alias without a server round trip. */
const richMenuSwitchActionSchema = z.object({
  type: z.literal('richmenuswitch'),
  label: label.optional(),
  richMenuAliasId: z.string().trim().min(1).max(100),
  data: z.string().trim().min(1).max(300),
});

const cameraActionSchema = z.object({
  type: z.enum(['camera', 'cameraRoll', 'location']),
  label: label.optional(),
});

const richMenuActionSchema = z.discriminatedUnion('type', [
  postbackActionSchema,
  messageActionSchema,
  uriActionSchema,
  datetimePickerActionSchema,
  richMenuSwitchActionSchema,
  cameraActionSchema,
]);

const boundsSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});

const richMenuAreaSchema = z.object({
  bounds: boundsSchema,
  action: richMenuActionSchema,
});

export const richMenuAreasSchema = z
  .array(richMenuAreaSchema)
  .min(1)
  .max(RICH_MENU_MAX_AREAS);

export type RichMenuArea = z.infer<typeof richMenuAreaSchema>;
export type RichMenuAction = z.infer<typeof richMenuActionSchema>;

const sizeSchema = z
  .object({
    width: z.number().int(),
    height: z.number().int(),
  })
  .refine(
    (size) =>
      RICH_MENU_SIZES.some(
        (allowed) =>
          allowed.width === size.width && allowed.height === size.height,
      ),
    {
      message: `size must be one of ${RICH_MENU_SIZES.map(
        (allowed) => `${allowed.width}x${allowed.height}`,
      ).join(', ')}`,
    },
  );

const templateFields = {
  name: z.string().trim().min(1).max(300),
  chatBarText: z.string().trim().min(1).max(14),
  size: sizeSchema,
  selected: z.boolean(),
  areas: richMenuAreasSchema,
  /** Registered on LINE at publish time so `richmenuswitch` can target this menu. */
  aliasId: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9_-]{1,32}$/,
      'aliasId may only contain lowercase letters, digits, hyphen and underscore',
    )
    .nullable()
    .optional(),
} as const;

/** Every area must sit fully inside the declared canvas, or LINE rejects the menu. */
const assertAreasFitSize = (
  value: { size?: { width: number; height: number }; areas?: RichMenuArea[] },
  context: z.RefinementCtx,
): void => {
  const { size, areas } = value;
  if (!size || !areas) return;

  areas.forEach((area, index) => {
    const { x, y, width, height } = area.bounds;

    if (x + width > size.width || y + height > size.height) {
      context.addIssue({
        code: 'custom',
        path: ['areas', index, 'bounds'],
        message: `Area is outside the ${size.width}x${size.height} menu`,
      });
    }
  });
};

const createRichMenuTemplateSchema = z
  .object({
    ...templateFields,
    selected: templateFields.selected.default(true),
  })
  .superRefine(assertAreasFitSize);

export class CreateRichMenuTemplateDto extends createZodDto(
  createRichMenuTemplateSchema,
) {}

const updateRichMenuTemplateSchema = z
  .object(templateFields)
  .partial()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'At least one field is required',
      });
    }

    // A partial update that moves only one of the two still has to agree; the
    // service re-checks the merged row before it writes.
    assertAreasFitSize(value, context);
  });

export class UpdateRichMenuTemplateDto extends createZodDto(
  updateRichMenuTemplateSchema,
) {}

export class RichMenuTemplateIdParamDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
  }),
) {}

export class LineUserIdParamDto extends createZodDto(
  z.object({
    lineUserId: z.string().trim().min(1).max(100),
  }),
) {}

export class ListRichMenuTemplateQueryDto extends createZodDto(
  z.object({
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  }),
) {}

export class PublishRichMenuTemplateDto extends createZodDto(
  z.object({
    /** Point every user at this menu once it is live. */
    setAsDefault: z.boolean().default(false),
  }),
) {}

export class LinkRichMenuUsersDto extends createZodDto(
  z.object({
    lineUserIds: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(RICH_MENU_BULK_MAX_USERS),
  }),
) {}

export class RichMenuStatsQueryDto extends createZodDto(
  z.object({
    /** ISO date-time; defaults to 30 days back. */
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  }),
) {}

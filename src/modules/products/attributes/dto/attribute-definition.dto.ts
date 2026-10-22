import { z } from 'zod';
import { ATTRIBUTE_KEY_PATTERN } from '../utils/attribute-key.constants';
import { isSafeAttributeKey } from '../utils/attribute-key.util';
import { definitionIssues } from '../utils/definition-rules.util';
import {
  ATTRIBUTE_SCOPES,
  ATTRIBUTE_TYPES,
} from '../types/attribute-definition.types';

/** Shape-only check at the HTTP edge; definitions are enforced in the service. */
export const attributeValueSchema = z.union([
  z.string().trim().min(1).max(500),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().trim().min(1).max(100)).max(30),
]);
const attributeKeySchema = z
  .string()
  .regex(ATTRIBUTE_KEY_PATTERN)
  .refine(isSafeAttributeKey, 'Not a custom field key');
export const attributeValuesSchema = z
  .record(attributeKeySchema, attributeValueSchema)
  .refine((value) => Object.keys(value).length <= 50, 'At most 50 fields');
export type AttributeValues = z.infer<typeof attributeValuesSchema>;
/** PATCH form: merged into the stored values, where null clears a field. */
export const attributePatchValuesSchema = z
  .record(attributeKeySchema, attributeValueSchema.nullable())
  .refine((value) => Object.keys(value).length <= 50, 'At most 50 fields');

/** A preset field definition, before defaults are applied. */
export const attributeDefinitionFields = z
  .object({
    key: z.string().regex(ATTRIBUTE_KEY_PATTERN),
    label: z.string().trim().min(1).max(100),
    scope: z.enum(ATTRIBUTE_SCOPES),
    type: z.enum(ATTRIBUTE_TYPES),
    options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    valueAliases: z
      .record(
        z.string().trim().min(1).max(100),
        z.array(z.string().trim().min(1).max(100)).max(20),
      )
      .refine((v) => Object.keys(v).length <= 200, 'At most 200 aliased values')
      .default({}),
    unit: z.string().trim().min(1).max(20).nullable().default(null),
    required: z.boolean().default(false),
    variantOption: z.boolean().default(false),
    searchable: z.boolean().default(true),
    aiVisible: z.boolean().default(true),
    categories: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    sortOrder: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

export const attributeDefinitionSchema = attributeDefinitionFields.superRefine(
  (d, context) => {
    for (const message of definitionIssues(d))
      context.addIssue({ code: 'custom', message });
  },
);
export type AttributeDefinitionInput = z.input<
  typeof attributeDefinitionSchema
>;

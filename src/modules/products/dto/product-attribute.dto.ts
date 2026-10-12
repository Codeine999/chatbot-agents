import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  ATTRIBUTE_SCOPES,
  BUSINESS_TYPES,
} from '../attributes/attribute-definition';

export class ListProductAttributesQueryDto extends createZodDto(
  z
    .object({
      status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
      scope: z.enum(ATTRIBUTE_SCOPES).optional(),
      category: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
) {}

export class BusinessPresetParamDto extends createZodDto(
  z.object({ type: z.enum(BUSINESS_TYPES as [string, ...string[]]) }).strict(),
) {}

export class ApplyBusinessPresetDto extends createZodDto(
  z
    .object({
      requestId: z.string().uuid().optional(),
      /** Limit the added fields to these categories; empty = every category. */
      categories: z
        .array(z.string().trim().min(1).max(100))
        .max(50)
        .default([]),
    })
    .strict(),
) {}

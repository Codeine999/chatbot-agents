import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  attributePatchValuesSchema,
  attributeValuesSchema,
} from '../attributes/dto/attribute-definition.dto';

// Decimal strings only: no coercion from JS floating point, rounding, or exponent notation.
export const productMoneySchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/);
const sku = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{N}._-]+$/u);
const text = (max: number) => z.string().trim().min(1).max(max);
const version = z.number().int().min(1).max(2147483646);
// Every business's field values go in `meta`, checked against the store's
// preset in ProductService; the edge only bounds their shape and key format.
const variantAttributesSchema = attributeValuesSchema;
const variantFields = z
  .object({
    sku,
    price: productMoneySchema.nullable().default(null),
    meta: variantAttributesSchema.default({}),
    trackStock: z.boolean().default(true),
    currency: z.literal('THB').default('THB'),
    compareAtPrice: productMoneySchema.nullable().optional(),
    active: z.boolean().default(true),
  })
  .strict();
const productFields = z
  .object({
    name: text(255),
    aliases: z.array(text(255)).max(30).default([]),
    description: z.string().trim().max(10000).default(''),
    category: text(100).nullable().default(null),
    language: z.enum(['th', 'en']).default('th'),
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('DRAFT'),
  })
  .strict();

// Zod 4 applies defaults inside optional fields. PATCH must use fields without defaults.
const productPatchFields = z
  .object({
    name: text(255),
    aliases: z.array(text(255)).max(30),
    description: z.string().trim().max(10000),
    category: text(100).nullable(),
    language: z.enum(['th', 'en']),
    status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  })
  .strict();
const variantPatchFields = z
  .object({
    sku,
    price: productMoneySchema.nullable(),
    // Merged into the stored values; null clears a field.
    meta: attributePatchValuesSchema,
    trackStock: z.boolean(),
    currency: z.literal('THB'),
    compareAtPrice: productMoneySchema.nullable(),
    active: z.boolean(),
  })
  .strict();

export const createProductSchema = productFields
  .extend({
    requestId: z.string().uuid().optional(),
    variants: z.array(variantFields).min(1).max(50).optional(),
  })
  .superRefine((data, context) => {
    if (
      data.status === 'ACTIVE' &&
      data.variants &&
      !data.variants.some((variant) => variant.active)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'Active products require an active variant',
      });
    }
    if (
      data.variants &&
      new Set(data.variants.map((variant) => variant.sku)).size !==
        data.variants.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'Variant SKUs must be unique',
      });
    }
  });
export class CreateProductDto extends createZodDto(createProductSchema) {}
/** Dev-only bulk create; each item still runs as its own catalog command. */
export const MAX_BULK_PRODUCTS = 50;
export class BulkCreateProductDto extends createZodDto(
  z.array(createProductSchema).min(1).max(MAX_BULK_PRODUCTS),
) {}
export class DeleteProductDto extends createZodDto(
  z
    .object({
      requestId: z.string().uuid(),
      expectedVersion: version,
    })
    .strict(),
) {}
export class UpdateProductDto extends createZodDto(
  productPatchFields
    .partial()
    .extend({
      requestId: z.string().uuid(),
      expectedVersion: version,
    })
    .refine(
      (data) =>
        Object.keys(data).some(
          (key) => !['requestId', 'expectedVersion'].includes(key),
        ),
      'Provide at least one product field',
    ),
) {}
export class CreateProductVariantDto extends createZodDto(
  variantFields.extend({
    requestId: z.string().uuid(),
    expectedProductVersion: version,
  }),
) {}
export class UpdateProductVariantDto extends createZodDto(
  variantPatchFields
    .partial()
    .extend({
      requestId: z.string().uuid(),
      expectedVersion: version,
      expectedProductVersion: version,
    })
    .refine(
      (data) =>
        Object.keys(data).some(
          (key) =>
            ![
              'requestId',
              'expectedVersion',
              'expectedProductVersion',
            ].includes(key),
        ),
      'Provide at least one variant field',
    ),
) {}
export class AdjustProductStockDto extends createZodDto(
  z
    .object({
      requestId: z.string().uuid(),
      expectedVersion: version,
      deltaOnHand: z
        .number()
        .int()
        .min(-2147483647)
        .max(2147483647)
        .refine((value) => value !== 0),
      reason: text(500),
    })
    .strict(),
) {}
export class ProductIdParamDto extends createZodDto(
  z.object({ id: z.string().uuid() }).strict(),
) {}
export class ProductVariantParamDto extends createZodDto(
  z.object({ id: z.string().uuid(), variantId: z.string().uuid() }).strict(),
) {}
export class ListProductsQueryDto extends createZodDto(
  z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
      q: text(200).optional(),
      status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    })
    .strict(),
) {}

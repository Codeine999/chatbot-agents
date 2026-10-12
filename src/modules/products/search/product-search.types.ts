import { z } from 'zod';
import type { CommerceScope } from '../../commerce/types/commerce-scope';

export const productPlanSchema = z
  .object({
    mode: z.enum(['PRODUCT', 'BOTH', 'KNOWLEDGE', 'GENERAL']),
    query: z.string().trim().max(1000),
    policyQuery: z.string().trim().max(1000).default(''),
    productIds: z.array(z.string().uuid()).max(5).default([]),
    variantIds: z.array(z.string().uuid()).max(12).default([]),
    /** Customer-chosen variant options, keyed by the store's field keys (สี, ความจุ, รสชาติ...). */
    options: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
            value: z.string().trim().min(1).max(100),
          })
          .strict(),
      )
      .max(6)
      .default([]),
    /** Predicates supported by the selected business profile; money/stock use their own fields. */
    filters: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
            operator: z.enum(['EQ', 'CONTAINS', 'NOT_CONTAINS', 'GTE', 'LTE']),
            value: z.union([
              z.string().trim().min(1).max(100),
              z.number().finite(),
              z.boolean(),
            ]),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    /** Option keys the customer asks to enumerate ("มีสีอะไรบ้าง"). */
    listOptions: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,49}$/))
      .max(6)
      .default([]),
    category: z.string().trim().max(100).nullable().default(null),
    minPrice: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .nullable()
      .default(null),
    maxPrice: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .nullable()
      .default(null),
    inStockOnly: z.boolean().default(false),
    /** Set by the backend from the original customer message, never trusted from the model. */
    stockQuantitySource: z.enum(['AVAILABLE', 'ON_HAND']).optional(),
    operation: z
      .enum(['DETAIL', 'LIST', 'CHEAPEST', 'COUNT', 'COMPARE', 'RECOMMEND'])
      .default('DETAIL'),
    countUnit: z.enum(['PRODUCTS', 'VARIANTS']).default('PRODUCTS'),
    asks: z
      .array(z.enum(['PRICE', 'STOCK', 'ATTRIBUTES', 'DESCRIPTION', 'POLICY']))
      .max(5)
      .default([]),
    ambiguous: z.boolean().default(false),
  })
  .strict();
export type ProductPlan = z.infer<typeof productPlanSchema>;
/** Model output excludes fields computed from the original message by the backend.
 * In particular, optional stockQuantitySource would violate strict JSON Schema's
 * requirement that every declared object property is required.
 */
export const productPlannerSchema = productPlanSchema.omit({
  stockQuantitySource: true,
});
export type CatalogRef = {
  companyId: string;
  productId: string;
  variantId?: string;
};
/** One customer-visible field value, already formatted, with the store's label. */
export type AttributeFact = { key: string; label: string; value: string };
export type ProductEvidence = {
  ref: string;
  productId: string;
  variantId: string;
  name: string;
  category?: string | null;
  aliases?: string[];
  /** Legacy persisted evidence only; new evidence carries variant sku. */
  productSku?: string;
  sku: string;
  description: string;
  /** This variant's details the selected business allows customers/AI to see. */
  details: AttributeFact[];
  /** This variant's visible option values (สี/ไซส์/ความจุ...). */
  options: AttributeFact[];
  price: string | null;
  effectiveCompareAtPrice?: string | null;
  discountAmount?: string | null;
  currency: 'THB';
  stock: 'IN_STOCK' | 'OUT_OF_STOCK' | 'NOT_TRACKED' | 'UNKNOWN';
  onHand?: number | null;
  reserved?: number | null;
  availableStock?: number | null;
  purchasable: boolean;
  fetchedAt: string;
  sourceRevision: number;
};
export type ProductSearchResult = {
  /** Pinned to the company business observed during the DB read. */
  businessType?: string | null;
  status:
    | 'FOUND'
    | 'MISSING_INPUT'
    | 'NO_MATCH'
    | 'NO_RELIABLE_CANDIDATE'
    | 'VARIANT_UNAVAILABLE'
    | 'UNAVAILABLE';
  evidence: ProductEvidence[];
  choices: { id: string; name: string }[];
  /**
   * FOUND: true when the customer named the product (name/alias/product SKU/variant SKU) or
   * referred to one already shown; false for search candidates whose
   * relevance the answer model must still judge.
   */
  identified?: boolean;
  /** VARIANT_UNAVAILABLE: the identified product's real option values, from the DB. */
  options?: { key: string; label: string; values: string[] }[];
  total?: number;
  truncated?: boolean;
};
export type ProductWorkflow = {
  turnId: string;
  scope: CommerceScope;
  plan: ProductPlan;
  result: ProductSearchResult;
  failed?: boolean;
};

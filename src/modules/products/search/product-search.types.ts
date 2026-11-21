import { z } from 'zod';
import type { CommerceScope } from '../../commerce/types/commerce-scope';
import type { AvailabilityState } from '../attributes/types/attribute-definition.types';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Customer's day/time window in the business timezone, resolved before search. */
export const productWhenSchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    after: timeOfDay.nullable(),
    before: timeOfDay.nullable(),
  })
  .strict();
export type ProductWhen = z.infer<typeof productWhenSchema>;

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);

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
      .enum([
        'DETAIL',
        'LIST',
        'CHEAPEST',
        'COUNT',
        'COMPARE',
        'RECOMMEND',
        'NEXT',
      ])
      .default('DETAIL'),
    countUnit: z.enum(['PRODUCTS', 'VARIANTS']).default('PRODUCTS'),
    asks: z
      .array(
        z.enum([
          'PRICE',
          'STOCK',
          'ATTRIBUTES',
          'DESCRIPTION',
          'POLICY',
          'SCHEDULE',
        ]),
      )
      .max(5)
      .default([]),
    ambiguous: z.boolean().default(false),
    // The next three exist only on plans of businesses that sell dated slots.
    // They are optional, not defaulted, so plans stored before they existed
    // (and every plan of a store without slots) keep exactly their old shape.
    /** Day/time the customer asked about. */
    when: productWhenSchema.nullable().optional(),
    /** People / pieces ("ไป 3 คน", "เอา 2 ตัว"). */
    quantity: z.number().int().min(1).max(50).nullable().optional(),
    /** Slots already shown to the customer that this question refers to. */
    slotIds: z.array(z.string().uuid()).max(12).optional(),
    /**
     * Keys of the store's customer-visible fields the question is about
     * ("ต้องต่อรถที่ไหน" -> transfer_points). Only these details are sent to
     * the answer model. Optional so plans stored before it existed keep their shape.
     */
    askFields: z.array(fieldKey).max(6).optional(),
  })
  .strict();
export type ProductPlan = z.infer<typeof productPlanSchema>;
/** Model output excludes fields computed from the original message by the backend.
 * In particular, optional stockQuantitySource would violate strict JSON Schema's
 * requirement that every declared object property is required.
 */
export const productPlannerSchema = productPlanSchema
  .omit({
    stockQuantitySource: true,
    when: true,
    quantity: true,
    slotIds: true,
    askFields: true,
  })
  .extend({
    askFields: z.array(fieldKey).max(6).default([]),
    when: productWhenSchema.nullable().default(null),
    quantity: z.number().int().min(1).max(50).nullable().default(null),
    slotIds: z.array(z.string().uuid()).max(12).default([]),
  });
/**
 * What a business without dated slots asks the model for: the schema the
 * planner has always used, so its provider request does not change.
 */
export const legacyProductPlannerSchema = productPlanSchema
  .omit({
    stockQuantitySource: true,
    when: true,
    quantity: true,
    slotIds: true,
    askFields: true,
  })
  .extend({
    askFields: z.array(fieldKey).max(6).default([]),
    operation: z
      .enum(['DETAIL', 'LIST', 'CHEAPEST', 'COUNT', 'COMPARE', 'RECOMMEND'])
      .default('DETAIL'),
    asks: z
      .array(z.enum(['PRICE', 'STOCK', 'ATTRIBUTES', 'DESCRIPTION', 'POLICY']))
      .max(5)
      .default([]),
  });
/** The planner's output schema for a store (slot businesses also get when/quantity/slotIds). */
export function plannerSchemaFor(slots: boolean) {
  return slots ? productPlannerSchema : legacyProductPlannerSchema;
}
export type CatalogRef = {
  companyId: string;
  productId: string;
  variantId?: string;
  /** A dated occurrence (departure, intake) that was shown. */
  slotId?: string;
};
/** One customer-visible field value, already formatted, with the store's label. */
export type AttributeFact = { key: string; label: string; value: string };
/** One dated occurrence of the variant, with availability computed by code. */
export type SlotEvidence = {
  slotId: string;
  startsAt: string;
  endsAt: string | null;
  state: AvailabilityState;
  seatsLeft: number | null;
  role: 'REQUESTED' | 'ALTERNATIVE';
};
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
  /** Exact price, or the lower bound when maxPrice is set. */
  price: string | null;
  /**
   * Upper bound of a range (docs/multiPriceTransport.md). Absent in evidence
   * persisted before ranges existed: those prices are exact.
   */
  maxPrice?: string | null;
  /** Why the price is a range or an estimate; absent = exact. */
  priceNote?: 'ESTIMATE' | 'BY_SLOT' | 'BY_SLOT_ESTIMATE';
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
  /** Present on schedule rows: this evidence is one (variant, slot) pair, ref = SLOT:<id>. */
  slot?: SlotEvidence;
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
  /** Slot businesses: how the requested day/time turned out. */
  slotOutcome?: 'MATCHED' | 'NONE_FITS' | 'NO_SLOT_IN_WINDOW' | 'OUT_OF_WINDOW';
  /** The customer's resolved request, to repeat back through tokens. */
  query?: {
    date: string | null;
    after: string | null;
    before: string | null;
    quantity: number | null;
  };
  /** Timezone the slot times must be shown in (set with slot results). */
  timeZone?: string;
  /** Dense timetables that were cut: how many, first and last start (HH:mm). */
  slotSummary?: { count: number; first: string; last: string };
};
export type ProductWorkflow = {
  turnId: string;
  scope: CommerceScope;
  plan: ProductPlan;
  result: ProductSearchResult;
  failed?: boolean;
};

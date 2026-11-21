import { z } from 'zod';
import type { KnowledgeItem } from '../../../shared/contracts/chat.types';
import type {
  AttributeFact,
  CatalogRef,
  ProductPlan,
  ProductEvidence,
  ProductWorkflow,
} from '../search/product-search.types';
import { stripJsonCodeFence } from '../../../utils/json.utils';
import {
  coversAskedFacts,
  productPriceRange,
  proseStatesOptionValue,
} from './product-answer.grounding';
import { catalogCapabilities, catalogLexicon } from '../search/catalog-fields';
import { scheduleAnswer, slotAsks } from '../slots/slot-answer';
import {
  availabilityLabel,
  formatArrival,
  formatClock,
  formatLocalDate,
  formatQueryTime,
  formatSlotDate,
  formatSlotTime,
} from '../slots/slot-format';
import { matchesSignals, proseMakesClaim } from '../business/lexicon-match';
import {
  DEFAULT_PRICE_WORDING,
  formatPrice,
  type PriceWording,
} from '../product-pricing';
import type { BusinessLexicon } from '../attributes/types/attribute-definition.types';

export const productAnswerSchema = z
  .object({
    decision: z.enum(['ANSWER', 'INSUFFICIENT_CONTEXT']),
    directlyAnswered: z.boolean(),
    answerTemplate: z.string().max(6000),
    evidenceIds: z.array(z.string()).max(30),
  })
  .strict();

/** Wording of the workflow's business; turns saved before presets had one keep ECOMMERCE. */
const lexiconOf = (workflow: ProductWorkflow): BusinessLexicon =>
  catalogLexicon(workflow.result.businessType);
const priceWording = (lexicon: BusinessLexicon): PriceWording =>
  lexicon.price ?? DEFAULT_PRICE_WORDING;
/** A price whose text carries a range/estimate note (never stated as final). */
const hasPriceNote = (e: ProductEvidence) =>
  e.maxPrice != null || e.priceNote !== undefined;

const stockStates = {
  IN_STOCK: 'AVAILABLE',
  OUT_OF_STOCK: 'FULL',
  NOT_TRACKED: 'NOT_TRACKED',
  UNKNOWN: 'UNKNOWN',
} as const;
const stockLabel = (
  lexicon: BusinessLexicon,
  stock: ProductEvidence['stock'],
) => lexicon.availability[stockStates[stock]];

export type ProductFieldPolicy = Readonly<{
  price: boolean;
  stock: boolean;
  description: boolean;
  attributes: boolean;
}>;

/**
 * Which product facts the customer's question needs. Identity (name, SKU and
 * the store's variant choices) is always available; price, stock, description
 * and details may be displayed only when asked or required by the operation.
 * Business snapshots sent to the model contain all public facts for context.
 */
export function productFieldPolicy(plan: ProductPlan): ProductFieldPolicy {
  const asks = new Set(plan.asks.filter((ask) => ask !== 'POLICY'));
  // "เล่าเรื่องเสื้อลินินหน่อย" names a product without a specific question.
  const overview = asks.size === 0 && plan.mode === 'PRODUCT';
  const weighs = plan.operation === 'COMPARE' || plan.operation === 'RECOMMEND';
  const detailOverview = overview && plan.operation === 'DETAIL';
  return {
    price:
      overview ||
      weighs ||
      asks.has('PRICE') ||
      plan.operation === 'CHEAPEST' ||
      plan.operation === 'LIST' ||
      plan.minPrice !== null ||
      plan.maxPrice !== null ||
      asks.has('SCHEDULE'),
    stock:
      overview ||
      weighs ||
      asks.has('STOCK') ||
      plan.inStockOnly ||
      (plan.quantity ?? null) !== null,
    description: detailOverview || weighs || asks.has('DESCRIPTION'),
    attributes:
      detailOverview ||
      weighs ||
      asks.has('ATTRIBUTES') ||
      asks.has('DESCRIPTION') ||
      askedFields(plan).length > 0,
  };
}

/** Detail keys the customer asked about; empty = the question is not narrowed to fields. */
export const askedFields = (plan: ProductPlan): readonly string[] =>
  plan.askFields ?? [];

/**
 * The details of one variant that may reach the model or a token. A question
 * narrowed to fields gets exactly those; otherwise every customer-visible
 * detail when details are asked at all.
 */
function shownDetails(
  plan: ProductPlan,
  policy: ProductFieldPolicy,
  details: readonly AttributeFact[],
): AttributeFact[] {
  const keys = askedFields(plan);
  if (keys.length) return details.filter((d) => keys.includes(d.key));
  return policy.attributes ? [...details] : [];
}

/** Select the quantity before generation; the model receives one stock quantity. */
function selectedStockQuantity(plan: ProductPlan, evidence: ProductEvidence) {
  const warehouse =
    plan.stockQuantitySource === 'ON_HAND' ||
    (plan.stockQuantitySource === undefined &&
      /(?:ในคลัง|ในโกดัง|on\s*hand|onhand|physical stock)/iu.test(plan.query));
  return {
    value: (warehouse ? evidence.onHand : evidence.availableStock) ?? null,
    label: warehouse ? 'จำนวนในคลัง' : 'จำนวนพร้อมขาย',
  };
}

// Identity facts any product answer may use: names and the store's variant choices.
// Existing persisted turns may still contain the former `code` identifier/token.
const IDENTITY_FIELDS = new Set(['name', 'sku', 'productSku', 'code']);

function productSku(evidence: ProductEvidence): string {
  return (
    evidence.productSku ??
    (evidence as ProductEvidence & { code?: string }).code ??
    evidence.sku
  );
}

function allowedField(field: string, policy: ProductFieldPolicy): boolean {
  if (
    IDENTITY_FIELDS.has(field) ||
    field.startsWith('opt.') ||
    field.startsWith('opts.')
  )
    return true;
  if (
    ['price', 'priceRange', 'originalPrice', 'discountAmount'].includes(field)
  )
    return policy.price;
  if (
    ['stockStatus', 'stockQuantity', 'onHand', 'availableStock'].includes(field)
  )
    return policy.stock;
  if (field === 'description') return policy.description;
  if (field === 'attributes' || field.startsWith('attr.'))
    return policy.attributes;
  return false;
}

const joinFacts = (facts: readonly AttributeFact[]) =>
  facts.map((f) => `${f.label}: ${f.value}`).join(', ');

/** Every value of one option across the displayed variants of a product. */
function optionValues(
  workflow: ProductWorkflow,
  productId: string,
  key: string,
) {
  return [
    ...new Set(
      workflow.result.evidence
        .filter((e) => e.productId === productId)
        .flatMap((e) =>
          e.options.filter((o) => o.key === key).map((o) => o.value),
        ),
    ),
  ];
}

export function productFactTokens(
  workflow: ProductWorkflow,
  policies: readonly KnowledgeItem[],
) {
  const policy = productFieldPolicy(workflow.plan);
  const lexicon = lexiconOf(workflow);
  const capabilities = catalogCapabilities(workflow.result.businessType);
  const bySlot = capabilities.inventory === 'SLOT_CAPACITY';
  const slotPolicy = slotAsks(workflow.plan);
  const zone = workflow.result.timeZone;
  const tokens: Record<string, { value: string; ref: string }> = {};
  workflow.result.evidence.forEach((e, i) => {
    const key = `e${i + 1}`;
    const details = shownDetails(workflow.plan, policy, e.details);
    const facts: Record<string, string> = {
      name: e.name,
      sku: e.sku,
      productSku: productSku(e),
      ...(!e.productSku ? { code: productSku(e) } : {}),
      description: e.description,
      attributes: joinFacts(details) || 'ไม่ได้ระบุคุณสมบัติ',
      price: formatPrice(e, priceWording(lexicon)),
      priceRange: productPriceRange(
        workflow.result.evidence,
        e.productId,
        priceWording(lexicon),
      ),
      ...(e.effectiveCompareAtPrice
        ? { originalPrice: `${e.effectiveCompareAtPrice} บาท` }
        : {}),
      ...(e.discountAmount
        ? { discountAmount: `${e.discountAmount} บาท` }
        : {}),
      stockStatus: stockLabel(lexicon, e.stock),
      ...(selectedStockQuantity(workflow.plan, e).value != null
        ? {
            stockQuantity: String(
              selectedStockQuantity(workflow.plan, e).value,
            ),
          }
        : {}),
      ...(workflow.result.businessType === undefined && e.onHand != null
        ? { onHand: String(e.onHand) }
        : {}),
      ...(workflow.result.businessType === undefined && e.availableStock != null
        ? { availableStock: String(e.availableStock) }
        : {}),
    };
    for (const detail of details) facts[`attr.${detail.key}`] = detail.value;
    for (const option of e.options) {
      facts[`opt.${option.key}`] = option.value;
      facts[`opts.${option.key}`] = optionValues(
        workflow,
        e.productId,
        option.key,
      ).join(', ');
    }
    // Seats live on slots, not on the variant: variant stock wording would
    // claim "unknown seats" about a slot that is full.
    if (bySlot)
      for (const field of [
        'stockStatus',
        'stockQuantity',
        'onHand',
        'availableStock',
      ])
        delete facts[field];
    for (const [field, value] of Object.entries(facts))
      if (allowedField(field, policy))
        tokens[`${key}.${field}`] = { value, ref: e.ref };
    const slot = e.slot;
    if (slot && bySlot) {
      const slotFacts: Record<string, string> = {};
      if (slotPolicy.schedule) {
        slotFacts.date = formatSlotDate(slot.startsAt, zone);
        slotFacts.time = formatSlotTime(slot.startsAt, zone);
        if (slot.endsAt)
          slotFacts.arrive = formatArrival(slot.startsAt, slot.endsAt, zone);
      }
      if (slotPolicy.availability) {
        slotFacts.availability = availabilityLabel(
          lexicon,
          capabilities.showQuantity,
          slot,
          workflow.result.query?.quantity ?? null,
        );
        // A seat number is only trustworthy for a slot whose seats are known.
        if (
          capabilities.showQuantity &&
          slot.seatsLeft !== null &&
          slot.state !== 'UNKNOWN' &&
          slot.state !== 'CLOSED'
        )
          slotFacts.seatsLeft = String(slot.seatsLeft);
      }
      for (const [field, value] of Object.entries(slotFacts))
        tokens[`${key}.${field}`] = { value, ref: e.ref };
    }
  });
  const asked = workflow.result.query;
  if (asked && bySlot) {
    if (asked.date)
      tokens['query.date'] = {
        value: formatLocalDate(asked.date),
        ref: 'QUERY:WHEN',
      };
    const time = formatQueryTime(asked.after, asked.before);
    if (time) tokens['query.time'] = { value: time, ref: 'QUERY:WHEN' };
    if (asked.quantity !== null)
      tokens['query.quantity'] = {
        value: String(asked.quantity),
        ref: 'QUERY:WHEN',
      };
  }
  const summary = workflow.result.slotSummary;
  if (summary && bySlot) {
    tokens['slots.count'] = { value: String(summary.count), ref: 'QUERY:WHEN' };
    tokens['slots.first'] = {
      value: formatClock(summary.first),
      ref: 'QUERY:WHEN',
    };
    tokens['slots.last'] = {
      value: formatClock(summary.last),
      ref: 'QUERY:WHEN',
    };
  }
  policies.forEach((e, i) => {
    tokens[`p${i + 1}.answer`] = {
      value: e.answer ?? '',
      ref: `${e.source}:${e.id}`,
    };
  });
  if (workflow.result.total !== undefined)
    tokens['catalog.count'] = {
      value: String(workflow.result.total),
      ref: 'CATALOG:COUNT',
    };
  return tokens;
}

/**
 * The evidence the answer model sees: one entry per product (shared facts
 * once) with its variant keys. Business snapshots contain all public facts;
 * allowed output tokens still follow the question. Old saved turns retain
 * their original projection when no businessType was saved.
 * Values here only inform wording; displayed facts still come from tokens.
 */
export function productPromptEvidence(
  workflow: ProductWorkflow,
  policies: readonly KnowledgeItem[],
) {
  const policy = productFieldPolicy(workflow.plan);
  const lexicon = lexiconOf(workflow);
  const capabilities = catalogCapabilities(workflow.result.businessType);
  const bySlot = capabilities.inventory === 'SLOT_CAPACITY';
  const slotPolicy = slotAsks(workflow.plan);
  const zone = workflow.result.timeZone;
  const fullSnapshot = workflow.result.businessType !== undefined;
  const fact = (prefix: string) => (f: AttributeFact) => ({
    token: `${prefix}.${f.key}`,
    label: f.label,
    value: f.value,
  });
  const products = new Map<
    string,
    {
      name: string;
      sku?: string;
      category?: string | null;
      aliases?: string[];
      description?: string;
      details?: ReturnType<ReturnType<typeof fact>>[];
      /** Labels of other customer-visible details the customer can still ask for. */
      moreInfoAvailable?: string[];
      variants: Record<string, unknown>[];
    }
  >();
  const optionKeys = new Set<string>();
  const detailKeys = new Set<string>();
  // Customer-visible details that exist but were not sent: named so the
  // answer can offer them, never described.
  const moreInfo = new Map<string, Map<string, string>>();
  workflow.result.evidence.forEach((e, i) => {
    const details = shownDetails(workflow.plan, policy, e.details);
    let product = products.get(e.productId);
    if (!product) {
      product = {
        name: e.name,
        ...(!fullSnapshot ? { sku: productSku(e) } : {}),
        category: e.category,
        aliases: e.aliases,
        ...(policy.description && e.description
          ? { description: e.description }
          : {}),
        ...(!fullSnapshot && policy.attributes && details.length
          ? { details: details.map(fact('attr')) }
          : {}),
        variants: [],
      };
      products.set(e.productId, product);
    }
    for (const d of details) detailKeys.add(d.key);
    if (fullSnapshot) {
      const sent = new Set(details.map((d) => d.key));
      const more = moreInfo.get(e.productId) ?? new Map<string, string>();
      for (const d of e.details) if (!sent.has(d.key)) more.set(d.key, d.label);
      moreInfo.set(e.productId, more);
    }
    for (const o of e.options) optionKeys.add(o.key);
    product.variants.push({
      key: `e${i + 1}`,
      ref: e.ref,
      sku: e.sku,
      options: e.options.map(fact('opt')),
      ...(fullSnapshot && details.length
        ? { details: details.map(fact('attr')) }
        : {}),
      ...(policy.price
        ? {
            price: formatPrice(e, priceWording(lexicon)),
            ...(e.effectiveCompareAtPrice
              ? { originalPrice: `${e.effectiveCompareAtPrice} บาท` }
              : {}),
            ...(e.discountAmount
              ? { discountAmount: `${e.discountAmount} บาท` }
              : {}),
          }
        : {}),
      ...(e.slot && bySlot
        ? {
            slot: {
              role: e.slot.role,
              ...(slotPolicy.schedule
                ? {
                    date: formatSlotDate(e.slot.startsAt, zone),
                    time: formatSlotTime(e.slot.startsAt, zone),
                    ...(e.slot.endsAt
                      ? {
                          arrive: formatArrival(
                            e.slot.startsAt,
                            e.slot.endsAt,
                            zone,
                          ),
                        }
                      : {}),
                  }
                : {}),
              ...(slotPolicy.availability
                ? {
                    availability: availabilityLabel(
                      lexicon,
                      capabilities.showQuantity,
                      e.slot,
                      workflow.result.query?.quantity ?? null,
                    ),
                    ...(capabilities.showQuantity &&
                    e.slot.seatsLeft !== null &&
                    e.slot.state !== 'UNKNOWN' &&
                    e.slot.state !== 'CLOSED'
                      ? { seatsLeft: e.slot.seatsLeft }
                      : {}),
                  }
                : {}),
            },
          }
        : {}),
      // Stock only when asked; the internal counters (onHand, reserved,
      // fetchedAt) never reach the model, only the one chosen quantity.
      ...(!bySlot && policy.stock
        ? {
            stockStatus: stockLabel(lexicon, e.stock),
            stockQuantity: selectedStockQuantity(workflow.plan, e).value,
            stockQuantityLabel: selectedStockQuantity(workflow.plan, e).label,
          }
        : {}),
    });
  });
  for (const [productId, more] of moreInfo)
    if (more.size)
      products.get(productId)!.moreInfoAvailable = [...more.values()];
  const fields = ['name', 'sku'];
  for (const key of optionKeys) fields.push(`opt.${key}`, `opts.${key}`);
  if (policy.price)
    fields.push('price', 'priceRange', 'originalPrice', 'discountAmount');
  if (policy.stock && !bySlot) fields.push('stockStatus', 'stockQuantity');
  if (bySlot && workflow.result.evidence.some((e) => e.slot)) {
    if (slotPolicy.schedule) fields.push('date', 'time', 'arrive');
    if (slotPolicy.availability) {
      fields.push('availability');
      if (capabilities.showQuantity) fields.push('seatsLeft');
    }
  }
  if (policy.description) fields.push('description');
  if (policy.attributes) {
    if (!askedFields(workflow.plan).length) fields.push('attributes');
    for (const key of detailKeys) fields.push(`attr.${key}`);
  }
  return {
    // CANDIDATE rows came from search; the model must check they are what was asked.
    businessType: workflow.result.businessType ?? null,
    matchedBy: workflow.result.identified ? 'CUSTOMER_NAMED' : 'CANDIDATE',
    products: [...products.values()],
    variantTokenFields: fields,
    policies: policies.map((item, i) => ({
      key: `p${i + 1}`,
      ref: `${item.source}:${item.id}`,
      title: item.title ?? '',
      answer: item.answer ?? '',
    })),
    ...(workflow.result.total !== undefined
      ? { catalogCount: { ref: 'CATALOG:COUNT', total: workflow.result.total } }
      : {}),
    partialList: workflow.result.truncated === true,
    ...(bySlot && workflow.result.slotOutcome
      ? {
          slotOutcome: workflow.result.slotOutcome,
          customerAsked: {
            ...(workflow.result.query?.date
              ? {
                  date: formatLocalDate(workflow.result.query.date),
                  dateToken: 'query.date',
                }
              : {}),
            ...(formatQueryTime(
              workflow.result.query?.after ?? null,
              workflow.result.query?.before ?? null,
            )
              ? {
                  time: formatQueryTime(
                    workflow.result.query?.after ?? null,
                    workflow.result.query?.before ?? null,
                  ),
                  timeToken: 'query.time',
                }
              : {}),
            ...(workflow.result.query?.quantity != null
              ? {
                  quantity: workflow.result.query.quantity,
                  quantityToken: 'query.quantity',
                }
              : {}),
          },
          ...(workflow.result.slotSummary
            ? {
                slotSummary: {
                  count: workflow.result.slotSummary.count,
                  first: formatClock(workflow.result.slotSummary.first),
                  last: formatClock(workflow.result.slotSummary.last),
                  tokens: ['slots.count', 'slots.first', 'slots.last'],
                },
              }
            : {}),
        }
      : {}),
  };
}

/**
 * The model's own judgment, separate from validation: INSUFFICIENT_CONTEXT
 * means the evidence does not answer the question (for example a cap found
 * for "หมวกกันน็อก"), so it must not be presented as the answer.
 */
export function productAnswerDecision(
  raw: string,
): 'ANSWER' | 'INSUFFICIENT_CONTEXT' | 'INVALID' {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonCodeFence(raw));
  } catch {
    return 'INVALID';
  }
  const parsed = productAnswerSchema.safeParse(value);
  if (!parsed.success) return 'INVALID';
  return parsed.data.decision === 'ANSWER' && parsed.data.directlyAnswered
    ? 'ANSWER'
    : 'INSUFFICIENT_CONTEXT';
}

/** Search candidates the model rejected: offered by name only, never as the answer. */
export function unmatchedProductAnswer(workflow: ProductWorkflow): {
  text: string;
  catalogRefs: CatalogRef[];
} {
  const products = new Map<string, string>();
  for (const e of workflow.result.evidence)
    if (products.size < 5) products.set(e.productId, e.name);
  const { clarify } = lexiconOf(workflow);
  return {
    text: `${clarify.unmatched}${
      products.size
        ? clarify.unmatchedNear.replace(
            '{names}',
            [...products.values()].join(' / '),
          )
        : ''
    }`,
    catalogRefs: [...products.keys()].map((productId) => ({
      companyId: workflow.scope.companyId,
      productId,
    })),
  };
}

/**
 * Coverage rules of a timetable answer: every named round shows its time, a
 * "nothing fits" outcome states the asked round's availability and offers at
 * least one alternative round.
 */
function slotRulesHold(
  used: readonly string[],
  workflow: ProductWorkflow,
): boolean {
  const evidence = workflow.result.evidence;
  const asks = slotAsks(workflow.plan);
  const rowOf = (key: string) => {
    const match = /^e(\d+)\.(.+)$/.exec(key);
    return match
      ? { row: evidence[Number(match[1]) - 1], field: match[2], n: match[1] }
      : undefined;
  };
  const parsed = used.map(rowOf).filter((x) => x?.row?.slot);
  if (asks.schedule) {
    if (!parsed.some((x) => x!.field === 'time')) return false;
    for (const x of parsed) if (!used.includes(`e${x!.n}.time`)) return false;
  }
  // Every round shown carries its own availability when it was asked.
  if (asks.availability)
    for (const x of parsed) {
      if (
        !used.includes(`e${x!.n}.availability`) &&
        !used.includes(`e${x!.n}.seatsLeft`)
      )
        return false;
    }
  if (workflow.result.slotOutcome === 'NONE_FITS') {
    const askedRow = parsed.some(
      (x) => x!.field === 'availability' && x!.row.slot!.role === 'REQUESTED',
    );
    const offered = parsed.some((x) => x!.row.slot!.role === 'ALTERNATIVE');
    if (!askedRow || !offered) return false;
  }
  return true;
}

/** Business numbers/stock claims are rendered from allowlisted DB evidence, never model prose. */
export function renderProductAnswer(
  raw: string,
  workflow: ProductWorkflow,
  policies: readonly KnowledgeItem[],
): string | undefined {
  const parsed = productAnswerSchema.safeParse(
    ((): unknown => {
      try {
        return JSON.parse(stripJsonCodeFence(raw));
      } catch {
        return null;
      }
    })(),
  );
  if (
    !parsed.success ||
    parsed.data.decision !== 'ANSWER' ||
    !parsed.data.directlyAnswered
  )
    return undefined;
  const { answerTemplate, evidenceIds } = parsed.data;
  const tokens = productFactTokens(workflow, policies);
  const refs = new Set([
    ...workflow.result.evidence.map((e) => e.ref),
    ...policies.map((e) => `${e.source}:${e.id}`),
    ...(workflow.result.total !== undefined ? ['CATALOG:COUNT'] : []),
    ...(workflow.result.query || workflow.result.slotSummary
      ? ['QUERY:WHEN']
      : []),
  ]);
  if (!evidenceIds.length || evidenceIds.some((id) => !refs.has(id)))
    return undefined;
  const used = [...answerTemplate.matchAll(/\{\{([^{}]+)\}\}/g)].map(
    (m) => m[1],
  );
  if (
    used.some((key) => !tokens[key] || !evidenceIds.includes(tokens[key].ref))
  )
    return undefined;
  // A remaining-quantity phrase is safe only when immediately backed by the validated available-stock token.
  const plain = answerTemplate
    .replace(
      /(?:คง)?เหลือ\s*(?=\{\{e\d+\.(?:availableStock|stockQuantity)\}\})/gu,
      '',
    )
    .replace(/\{\{[^{}]+\}\}/g, '');
  if (/[{}\d๐-๙]/u.test(plain) || proseMakesClaim(lexiconOf(workflow), plain))
    return undefined;
  // An estimated or per-round price must never be called final in prose.
  const evidenceRows = workflow.result.evidence;
  const showsNotedPrice = used.some((key) => {
    const match = /^e(\d+)\.(price|priceRange)$/.exec(key);
    const row = match && evidenceRows[Number(match[1]) - 1];
    if (!match || !row) return false;
    return match[2] === 'price'
      ? hasPriceNote(row)
      : evidenceRows.some(
          (e) => e.productId === row.productId && hasPriceNote(e),
        );
  });
  if (
    showsNotedPrice &&
    matchesSignals(
      lexiconOf(workflow),
      priceWording(lexiconOf(workflow)).certainWords,
      plain,
    )
  )
    return undefined;
  if (
    (workflow.plan.mode === 'PRODUCT' || workflow.plan.mode === 'BOTH') &&
    !used.some((k) => /^e\d+\.name$/.test(k)) &&
    workflow.plan.operation !== 'COUNT'
  )
    return undefined;
  if (
    workflow.plan.asks.includes('PRICE') &&
    workflow.result.evidence.length &&
    !used.some((k) => k.endsWith('.price') || k.endsWith('.priceRange'))
  )
    return undefined;
  const slotEvidence = workflow.result.evidence.filter((e) => e.slot);
  // A slot business states seats through availability/seatsLeft, per slot.
  const stockTokens = slotEvidence.length
    ? /\.(?:availability|seatsLeft)$/
    : /\.(?:stockStatus|stockQuantity|onHand|availableStock)$/;
  if (
    workflow.plan.asks.includes('STOCK') &&
    workflow.result.evidence.length &&
    (slotEvidence.length ||
      catalogCapabilities(workflow.result.businessType).inventory !==
        'SLOT_CAPACITY') &&
    !used.some((k) => stockTokens.test(k))
  )
    return undefined;
  // Every displayed variant must cover the requested mutable facts, especially comparisons.
  for (const nameToken of used.filter((k) => /^e\d+\.name$/.test(k))) {
    const prefix = nameToken.slice(0, -4);
    if (
      workflow.plan.asks.includes('PRICE') &&
      !used.includes(`${prefix}price`) &&
      !used.includes(`${prefix}priceRange`)
    )
      return undefined;
    const named = workflow.result.evidence[Number(prefix.slice(1, -1)) - 1];
    if (
      workflow.plan.asks.includes('STOCK') &&
      !(
        named?.slot
          ? ['availability', 'seatsLeft']
          : ['stockStatus', 'stockQuantity', 'onHand', 'availableStock']
      ).some((field) => used.includes(`${prefix}${field}`)) &&
      (named?.slot ||
        catalogCapabilities(workflow.result.businessType).inventory !==
          'SLOT_CAPACITY')
    )
      return undefined;
  }
  if (slotEvidence.length && !slotRulesHold(used, workflow)) return undefined;
  // Prices of every variant and the asked details must be shown, never one picked.
  if (!coversAskedFacts(used, workflow)) return undefined;
  // Options ("สีขาว") written as prose would claim a variant the evidence may not be.
  if (
    proseStatesOptionValue(
      answerTemplate.replace(/\{\{[^{}]+\}\}/g, ' '),
      workflow,
    )
  )
    return undefined;
  if (workflow.plan.operation === 'COUNT' && !used.includes('catalog.count'))
    return undefined;
  // "มีสีอะไรบ้าง" must list every value, not one variant's.
  for (const key of workflow.plan.listOptions)
    if (
      workflow.result.evidence.some((e) =>
        e.options.some((o) => o.key === key),
      ) &&
      !used.some((k) => k.endsWith(`.opts.${key}`))
    )
      return undefined;
  if (
    (workflow.plan.mode === 'BOTH' || workflow.plan.mode === 'KNOWLEDGE') &&
    !used.some((k) => /^p\d+\.answer$/.test(k))
  )
    return undefined;
  if (workflow.plan.operation === 'COMPARE') {
    const covered = new Set(
      used
        .filter((k) => /^e\d+\.name$/.test(k))
        .map(
          (k) =>
            workflow.result.evidence[Number(k.slice(1).split('.')[0]) - 1]
              ?.variantId,
        ),
    );
    if (covered.size < 2) return undefined;
  }
  const rendered = answerTemplate
    .replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => tokens[key].value)
    .trim();
  if (!rendered || rendered.length > 4500) return undefined;
  return (
    rendered +
    (workflow.result.truncated
      ? '\nแสดงเพียงบางรายการ กรุณาระบุเงื่อนไขเพิ่มเติมค่ะ'
      : '')
  );
}

/** Only facts actually displayed become follow-up context; citations alone are not presentation. */
export function presentedProductRefs(
  raw: string,
  workflow: ProductWorkflow,
): CatalogRef[] {
  const parsed = productAnswerSchema.parse(JSON.parse(stripJsonCodeFence(raw)));
  const selected = new Set<string>();
  for (const match of parsed.answerTemplate.matchAll(
    /\{\{e(\d+)\.([^{}]+)\}\}/g,
  )) {
    const evidence = workflow.result.evidence[Number(match[1]) - 1];
    if (!evidence) continue;
    selected.add(evidence.ref);
    // Product-level tokens present every variant they summarize.
    if (match[2].startsWith('opts.') || match[2] === 'priceRange')
      for (const variant of workflow.result.evidence)
        if (variant.productId === evidence.productId) selected.add(variant.ref);
  }
  return workflow.result.evidence
    .filter((e) => selected.has(e.ref))
    .map((e) => ({
      companyId: workflow.scope.companyId,
      productId: e.productId,
      variantId: e.variantId,
      ...(e.slot ? { slotId: e.slot.slotId } : {}),
    }));
}

/** Price and stock of one variant, when the question needs them. */
function mutableFacts(
  e: ProductEvidence,
  plan: ProductPlan,
  policy: ProductFieldPolicy,
  lexicon: BusinessLexicon,
  bySlot = false,
): string[] {
  const quantity = selectedStockQuantity(plan, e);
  return [
    !policy.price
      ? ''
      : e.price !== null
        ? `ราคา ${formatPrice(e, priceWording(lexicon))}`
        : 'ยังไม่ได้ระบุราคา',
    // Seats of a dated business live on its rounds, never on the route.
    policy.stock && !bySlot
      ? quantity.value != null
        ? `${stockLabel(lexicon, e.stock)} · ${quantity.label} ${quantity.value} ${lexicon.unit}`
        : stockLabel(lexicon, e.stock)
      : '',
  ].filter(Boolean);
}

/**
 * Detail questions ("เนื้อผ้าอะไร") answered from stored facts: one line per
 * product with the details its variants share, then each variant that adds
 * its own details, price or stock.
 */
function detailedProductLines(
  shown: readonly ProductEvidence[],
  plan: ProductPlan,
  policy: ProductFieldPolicy,
  lexicon: BusinessLexicon,
  bySlot: boolean,
): string {
  const products = new Map<string, ProductEvidence[]>();
  for (const e of shown)
    products.set(e.productId, [...(products.get(e.productId) ?? []), e]);
  const detailsOf = (v: ProductEvidence) =>
    shownDetails(plan, policy, v.details);
  return [...products.values()]
    .flatMap((variants) => {
      const [first] = variants;
      const shared = detailsOf(first).filter((d) =>
        variants.every((v) =>
          detailsOf(v).some((x) => x.key === d.key && x.value === d.value),
        ),
      );
      const header = [
        first.name,
        policy.description ? first.description : '',
        policy.attributes
          ? joinFacts(shared) ||
            (variants.every((v) => !detailsOf(v).length)
              ? 'ไม่ได้ระบุคุณสมบัติ'
              : '')
          : '',
      ].filter(Boolean);
      const isShared = (d: AttributeFact) =>
        shared.some((s) => s.key === d.key && s.value === d.value);
      const lines = variants.flatMap((v) => {
        const extra = [
          policy.attributes
            ? joinFacts(detailsOf(v).filter((d) => !isShared(d)))
            : '',
          ...mutableFacts(v, plan, policy, lexicon, bySlot),
        ].filter(Boolean);
        return extra.length
          ? [`- ${[...v.options.map((o) => o.value), ...extra].join(' · ')}`]
          : [];
      });
      return [header.join(' · '), ...lines];
    })
    .join('\n');
}

export function safeProductAnswer(
  workflow: ProductWorkflow,
  policies: readonly KnowledgeItem[],
): string {
  const result = workflow.result;
  const lexicon = lexiconOf(workflow);
  if (result.status === 'VARIANT_UNAVAILABLE') {
    const label = (key: string) =>
      result.options?.find((o) => o.key === key)?.label ?? key;
    const wanted = workflow.plan.options
      .map((o) => `${label(o.key)} ${o.value}`)
      .join(' ');
    const options = (result.options ?? [])
      .map((o) => `${o.label}ที่มี: ${o.values.join(', ')}`)
      .join(' · ');
    return `${result.choices[0]?.name ?? `${lexicon.itemNoun}นี้`} ยังไม่มี${wanted ? ` ${wanted}` : 'ตัวเลือกที่ถาม'}ค่ะ${options ? `\n${options}` : ''}`;
  }
  if (result.status === 'MISSING_INPUT')
    return result.choices.length
      ? lexicon.clarify.which.replace(
          '{choices}',
          result.choices.map((c) => c.name).join(' / '),
        )
      : lexicon.clarify.none;
  if (result.status === 'UNAVAILABLE') return lexicon.clarify.unavailable;
  if (result.status !== 'FOUND') return lexicon.clarify.notFound;
  if (result.slotOutcome !== undefined) return scheduleAnswer(workflow);
  if (workflow.plan.operation === 'COUNT')
    return `พบ ${result.total ?? 0} รายการที่ตรงกับเงื่อนไขค่ะ`;
  const policy = productFieldPolicy(workflow.plan);
  const bySlot =
    catalogCapabilities(result.businessType).inventory === 'SLOT_CAPACITY';
  const shown = result.evidence.slice(0, 5);
  const text =
    policy.attributes || policy.description
      ? detailedProductLines(shown, workflow.plan, policy, lexicon, bySlot)
      : shown
          .map((e) =>
            [
              e.name,
              ...e.options.map((o) => o.value),
              ...mutableFacts(e, workflow.plan, policy, lexicon, bySlot),
            ].join(' · '),
          )
          .join('\n');
  // "มีสีอะไรบ้าง" asks for every value of an option, so list them per product.
  const productIds = [...new Set(shown.map((e) => e.productId))];
  const listed = productIds.flatMap((productId) => {
    const first = shown.find((e) => e.productId === productId)!;
    return workflow.plan.listOptions.flatMap((key) => {
      const values = optionValues(workflow, productId, key);
      const label = first.options.find((o) => o.key === key)?.label ?? key;
      const owner = productIds.length > 1 ? ` (${first.name})` : '';
      return values.length
        ? [`${label}ที่มี${owner}: ${values.join(', ')}`]
        : [];
    });
  });
  return (
    text +
    (listed.length ? `\n${listed.join('\n')}` : '') +
    (result.truncated || result.evidence.length > 5
      ? '\nแสดงเพียงบางรายการ กรุณาระบุรุ่นหรือเงื่อนไขเพิ่มเติมค่ะ'
      : '') +
    (workflow.plan.mode === 'BOTH'
      ? `\n${policies.map((e) => e.answer).join('\n')}`
      : '')
  );
}

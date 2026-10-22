import { z } from 'zod';
import type { KnowledgeItem } from '../../shared/types/chat.types';
import type {
  AttributeFact,
  CatalogRef,
  ProductPlan,
  ProductEvidence,
  ProductWorkflow,
} from '../../../products/search/product-search.types';
import { stripJsonCodeFence } from '../../../../utils/json.utils';
import {
  coversAskedFacts,
  productPriceRange,
  proseStatesOptionValue,
} from './product-answer.grounding';

export const productAnswerSchema = z
  .object({
    decision: z.enum(['ANSWER', 'INSUFFICIENT_CONTEXT']),
    directlyAnswered: z.boolean(),
    answerTemplate: z.string().max(6000),
    evidenceIds: z.array(z.string()).max(30),
  })
  .strict();

const stockLabels = {
  IN_STOCK: 'มีสินค้าคงเหลือ ณ เวลาตรวจสอบ',
  OUT_OF_STOCK: 'สินค้าหมด ณ เวลาตรวจสอบ',
  NOT_TRACKED:
    'ร้านไม่ได้เปิดระบบติดตามสต็อก กรุณาสอบถามเจ้าหน้าที่เพื่อยืนยัน',
  UNKNOWN: 'ยังตรวจสอบสต็อกไม่ได้',
};

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
      plan.maxPrice !== null,
    stock: overview || weighs || asks.has('STOCK') || plan.inStockOnly,
    description: detailOverview || weighs || asks.has('DESCRIPTION'),
    attributes:
      detailOverview ||
      weighs ||
      asks.has('ATTRIBUTES') ||
      asks.has('DESCRIPTION'),
  };
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
  const tokens: Record<string, { value: string; ref: string }> = {};
  workflow.result.evidence.forEach((e, i) => {
    const key = `e${i + 1}`;
    const facts: Record<string, string> = {
      name: e.name,
      sku: e.sku,
      productSku: productSku(e),
      ...(!e.productSku ? { code: productSku(e) } : {}),
      description: e.description,
      attributes: joinFacts(e.details) || 'ไม่ได้ระบุคุณสมบัติ',
      price: e.price !== null ? `${e.price} บาท` : 'ยังไม่ได้ระบุราคา',
      priceRange: productPriceRange(workflow.result.evidence, e.productId),
      ...(e.effectiveCompareAtPrice
        ? { originalPrice: `${e.effectiveCompareAtPrice} บาท` }
        : {}),
      ...(e.discountAmount
        ? { discountAmount: `${e.discountAmount} บาท` }
        : {}),
      stockStatus: stockLabels[e.stock],
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
    for (const detail of e.details) facts[`attr.${detail.key}`] = detail.value;
    for (const option of e.options) {
      facts[`opt.${option.key}`] = option.value;
      facts[`opts.${option.key}`] = optionValues(
        workflow,
        e.productId,
        option.key,
      ).join(', ');
    }
    for (const [field, value] of Object.entries(facts))
      if (allowedField(field, policy))
        tokens[`${key}.${field}`] = { value, ref: e.ref };
  });
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
      variants: Record<string, unknown>[];
    }
  >();
  const optionKeys = new Set<string>();
  const detailKeys = new Set<string>();
  workflow.result.evidence.forEach((e, i) => {
    let product = products.get(e.productId);
    if (!product) {
      product = {
        name: e.name,
        ...(!fullSnapshot ? { sku: productSku(e) } : {}),
        category: e.category,
        aliases: e.aliases,
        ...((fullSnapshot || policy.description) && e.description
          ? { description: e.description }
          : {}),
        ...(!fullSnapshot && policy.attributes && e.details.length
          ? { details: e.details.map(fact('attr')) }
          : {}),
        variants: [],
      };
      products.set(e.productId, product);
      if (policy.attributes) for (const d of e.details) detailKeys.add(d.key);
    }
    if (policy.attributes) for (const d of e.details) detailKeys.add(d.key);
    for (const o of e.options) optionKeys.add(o.key);
    product.variants.push({
      key: `e${i + 1}`,
      ref: e.ref,
      sku: e.sku,
      options: e.options.map(fact('opt')),
      ...(fullSnapshot ? { details: e.details.map(fact('attr')) } : {}),
      ...(fullSnapshot || policy.price
        ? {
            price: e.price !== null ? `${e.price} บาท` : 'ยังไม่ได้ระบุราคา',
            ...(e.effectiveCompareAtPrice
              ? { originalPrice: `${e.effectiveCompareAtPrice} บาท` }
              : {}),
            ...(e.discountAmount
              ? { discountAmount: `${e.discountAmount} บาท` }
              : {}),
          }
        : {}),
      ...(fullSnapshot || policy.stock
        ? {
            stockStatus: stockLabels[e.stock],
            ...(fullSnapshot
              ? {
                  onHand: e.onHand,
                  reserved: e.reserved,
                  availableStock: e.availableStock,
                  fetchedAt: e.fetchedAt,
                }
              : {}),
            stockQuantity: selectedStockQuantity(workflow.plan, e).value,
            stockQuantityLabel: selectedStockQuantity(workflow.plan, e).label,
          }
        : {}),
    });
  });
  const fields = ['name', 'sku'];
  for (const key of optionKeys) fields.push(`opt.${key}`, `opts.${key}`);
  if (policy.price)
    fields.push('price', 'priceRange', 'originalPrice', 'discountAmount');
  if (policy.stock) fields.push('stockStatus', 'stockQuantity');
  if (policy.description) fields.push('description');
  if (policy.attributes) {
    fields.push('attributes');
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
  return {
    text: `ยังไม่พบสินค้าที่ตรงกับคำถามนี้ค่ะ${
      products.size
        ? `\nสินค้าที่ใกล้เคียง: ${[...products.values()].join(' / ')} สนใจตัวไหนแจ้งได้เลยค่ะ`
        : ''
    }`,
    catalogRefs: [...products.keys()].map((productId) => ({
      companyId: workflow.scope.companyId,
      productId,
    })),
  };
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
  if (
    /[{}\d๐-๙]/u.test(plain) ||
    /(?:ราคา\s*(?:คือ|อยู่ที่|เพียง)|\d|บาท|มีของ|มีสินค้า|พร้อมส่ง|สินค้าหมด|หมดสต็อก|เหลือ\s|ส่งฟรี|free shipping|in stock|out of stock)/iu.test(
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
  if (
    workflow.plan.asks.includes('STOCK') &&
    workflow.result.evidence.length &&
    !used.some((k) =>
      /\.(?:stockStatus|stockQuantity|onHand|availableStock)$/.test(k),
    )
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
    if (
      workflow.plan.asks.includes('STOCK') &&
      !['stockStatus', 'stockQuantity', 'onHand', 'availableStock'].some(
        (field) => used.includes(`${prefix}${field}`),
      )
    )
      return undefined;
  }
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
    }));
}

/** Price and stock of one variant, when the question needs them. */
function mutableFacts(
  e: ProductEvidence,
  plan: ProductPlan,
  policy: ProductFieldPolicy,
): string[] {
  const quantity = selectedStockQuantity(plan, e);
  return [
    !policy.price
      ? ''
      : e.price !== null
        ? `ราคา ${e.price} บาท`
        : 'ยังไม่ได้ระบุราคา',
    policy.stock
      ? quantity.value != null
        ? `${stockLabels[e.stock]} · ${quantity.label} ${quantity.value} ชิ้น`
        : stockLabels[e.stock]
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
): string {
  const products = new Map<string, ProductEvidence[]>();
  for (const e of shown)
    products.set(e.productId, [...(products.get(e.productId) ?? []), e]);
  return [...products.values()]
    .flatMap((variants) => {
      const [first] = variants;
      const shared = first.details.filter((d) =>
        variants.every((v) =>
          v.details.some((x) => x.key === d.key && x.value === d.value),
        ),
      );
      const header = [
        first.name,
        policy.description ? first.description : '',
        policy.attributes
          ? joinFacts(shared) ||
            (variants.every((v) => !v.details.length)
              ? 'ไม่ได้ระบุคุณสมบัติ'
              : '')
          : '',
      ].filter(Boolean);
      const isShared = (d: AttributeFact) =>
        shared.some((s) => s.key === d.key && s.value === d.value);
      const lines = variants.flatMap((v) => {
        const extra = [
          policy.attributes
            ? joinFacts(v.details.filter((d) => !isShared(d)))
            : '',
          ...mutableFacts(v, plan, policy),
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
  if (result.status === 'VARIANT_UNAVAILABLE') {
    const label = (key: string) =>
      result.options?.find((o) => o.key === key)?.label ?? key;
    const wanted = workflow.plan.options
      .map((o) => `${label(o.key)} ${o.value}`)
      .join(' ');
    const options = (result.options ?? [])
      .map((o) => `${o.label}ที่มี: ${o.values.join(', ')}`)
      .join(' · ');
    return `${result.choices[0]?.name ?? 'สินค้านี้'} ยังไม่มี${wanted ? ` ${wanted}` : 'ตัวเลือกที่ถาม'}ค่ะ${options ? `\n${options}` : ''}`;
  }
  if (result.status === 'MISSING_INPUT')
    return result.choices.length
      ? `หมายถึงสินค้ารุ่นไหนคะ: ${result.choices.map((c) => c.name).join(' / ')} หรือระบุสีและขนาดที่ต้องการได้ค่ะ`
      : 'สนใจสินค้าประเภทไหนหรือรุ่นไหนคะ?';
  if (result.status === 'UNAVAILABLE')
    return 'ขณะนี้ยังตรวจสอบข้อมูลสินค้าไม่ได้ กรุณาสอบถามเจ้าหน้าที่ค่ะ';
  if (result.status !== 'FOUND')
    return 'ยังไม่พบข้อมูลสินค้าที่ตรงกับคำถาม กรุณาระบุชื่อรุ่นหรือ SKU เพิ่มเติมค่ะ';
  if (workflow.plan.operation === 'COUNT')
    return `พบ ${result.total ?? 0} รายการที่ตรงกับเงื่อนไขค่ะ`;
  const policy = productFieldPolicy(workflow.plan);
  const shown = result.evidence.slice(0, 5);
  const text =
    policy.attributes || policy.description
      ? detailedProductLines(shown, workflow.plan, policy)
      : shown
          .map((e) =>
            [
              e.name,
              ...e.options.map((o) => o.value),
              ...mutableFacts(e, workflow.plan, policy),
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

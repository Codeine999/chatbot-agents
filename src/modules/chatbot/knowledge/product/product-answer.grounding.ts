import { Prisma } from '../../../../generated/prisma/client';
import { normalizeText } from '../../../../utils/text.utils';
import { catalogFields } from '../../../products/search/catalog-fields';
import type {
  ProductEvidence,
  ProductWorkflow,
} from '../../../products/search/product-search.types';

/**
 * Business-neutral grounding checks for a model answer template. Facts come
 * from the store's own evidence and field definitions, never from word lists:
 * the same rules hold for clothes, food, rooms or phones.
 */

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
const words = (text: string) =>
  [...segmenter.segment(normalizeText(text))]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);

function containsPhrase(
  haystack: readonly string[],
  phrase: readonly string[],
) {
  if (!phrase.length) return false;
  for (let i = 0; i + phrase.length <= haystack.length; i++)
    if (phrase.every((word, j) => haystack[i + j] === word)) return true;
  return false;
}

/** "690.00 บาท" or "690.00–720.00 บาท" across one product's displayed variants. */
export function productPriceRange(
  evidence: readonly ProductEvidence[],
  productId: string,
): string {
  const prices = evidence
    .filter((e) => e.productId === productId && e.price !== null)
    .map((e) => new Prisma.Decimal(e.price!))
    .sort((a, b) => a.comparedTo(b));
  if (!prices.length) return 'ยังไม่ได้ระบุราคา';
  const [low, high] = [prices[0], prices[prices.length - 1]];
  return low.eq(high)
    ? `${low.toFixed(2)} บาท`
    : `${low.toFixed(2)}–${high.toFixed(2)} บาท`;
}

/**
 * Every product the answer names must carry the facts that were asked:
 * PRICE shows each distinct variant price (or the price range), and
 * ATTRIBUTES/DESCRIPTION show at least one stored detail token. A name with
 * prose around it ("ตัดจากผ้าไหมแท้") is not an answer about its material.
 */
export function coversAskedFacts(
  used: readonly string[],
  workflow: ProductWorkflow,
): boolean {
  const { plan } = workflow;
  const evidence = workflow.result.evidence;
  const fields = new Map<string, Set<string>>();
  const shownPrices = new Map<string, Set<string>>();
  for (const key of used) {
    const match = /^e(\d+)\.(.+)$/.exec(key);
    const item = match && evidence[Number(match[1]) - 1];
    if (!match || !item) continue;
    const field = match[2];
    if (!fields.has(item.productId)) fields.set(item.productId, new Set());
    fields.get(item.productId)!.add(field);
    if (field === 'price' && item.price !== null) {
      if (!shownPrices.has(item.productId))
        shownPrices.set(item.productId, new Set());
      shownPrices.get(item.productId)!.add(item.price);
    }
  }
  const asksDetails =
    plan.asks.includes('ATTRIBUTES') || plan.asks.includes('DESCRIPTION');
  const isDetail = (field: string) =>
    field === 'attributes' ||
    field === 'description' ||
    field.startsWith('attr.') ||
    plan.listOptions.some((key) => field === `opts.${key}`);
  for (const [productId, productFields] of fields) {
    if (!productFields.has('name')) continue;
    // "Cheapest" shows the lowest price, not every price of the product.
    if (
      plan.asks.includes('PRICE') &&
      plan.operation !== 'CHEAPEST' &&
      !productFields.has('priceRange')
    ) {
      const shown = shownPrices.get(productId) ?? new Set<string>();
      if (
        evidence.some(
          (e) =>
            e.productId === productId &&
            e.price !== null &&
            !shown.has(e.price),
        )
      )
        return false;
    }
    if (asksDetails && ![...productFields].some(isDetail)) return false;
  }
  return true;
}

/**
 * True when template prose (text outside tokens) states a variant option
 * value such as a colour or size ("สีขาว") instead of a token. The values are
 * the store's own: evidence options plus the field definitions' declared
 * values and aliases. Values the customer chose are true for every evidence
 * row, and words of the product's own name are identity, so both may appear.
 */
export function proseStatesOptionValue(
  prose: string,
  workflow: ProductWorkflow,
): boolean {
  const optionFields = catalogFields(
    workflow.result.businessType ?? null,
  ).filter((field) => field.variantOption);
  // Thai segmentation can fuse a label with its value ("สีดำ"), so the
  // labelled form is matched too.
  const labelled = (label: string, values: readonly string[]) => [
    ...values,
    ...values.map((value) => `${label}${value}`),
  ];
  const groups: string[][] = [
    ...workflow.result.evidence.flatMap((e) =>
      e.options.map((o) => labelled(o.label, [o.value])),
    ),
    ...optionFields.flatMap((field) => [
      ...field.options.map((value) => labelled(field.label, [value])),
      ...Object.entries(field.valueAliases).map(([value, aliases]) =>
        labelled(field.label, [value, ...aliases]),
      ),
    ]),
  ];
  const chosen = new Set(
    workflow.plan.options.map((o) => normalizeText(o.value)),
  );
  const identity = workflow.result.evidence.flatMap((e) =>
    words([e.name, ...(e.aliases ?? []), e.category ?? ''].join(' ')),
  );
  const proseWords = words(prose);
  return groups.some((group) => {
    const phrases = group.map(words);
    const allowed =
      group.some((value) => chosen.has(normalizeText(value))) ||
      phrases.some((phrase) => containsPhrase(identity, phrase));
    return (
      !allowed && phrases.some((phrase) => containsPhrase(proseWords, phrase))
    );
  });
}

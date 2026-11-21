import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
type Money = Prisma.Decimal | string | null;
type VariantPrice = {
  price: Money;
  /** Set = the price is not final yet and lies in price..maxPrice. */
  maxPrice?: Money;
  compareAtPrice?: Money;
};

export function assertProductPricing(variants: readonly VariantPrice[]) {
  for (const variant of variants) {
    assertPriceRange(variant);
    if (variant.compareAtPrice == null) continue;
    if (variant.maxPrice != null)
      throw new BadRequestException(
        'compareAtPrice cannot be combined with maxPrice (an estimated price has no discount)',
      );
    if (
      variant.price == null ||
      !new Prisma.Decimal(variant.compareAtPrice).gt(
        new Prisma.Decimal(variant.price),
      )
    ) {
      throw new BadRequestException(
        'compareAtPrice requires a selling price and must be greater than it',
      );
    }
  }
}

/** A range needs its lower bound, and the upper bound must be above it. */
export function assertPriceRange(row: { price: Money; maxPrice?: Money }) {
  if (row.maxPrice == null) return;
  if (
    row.price == null ||
    !new Prisma.Decimal(row.maxPrice).gt(new Prisma.Decimal(row.price))
  )
    throw new BadRequestException(
      'maxPrice requires a price and must be greater than it',
    );
}

export function productDiscount(variant: VariantPrice) {
  if (variant.price == null || variant.compareAtPrice == null)
    return { effectiveCompareAtPrice: null, discountAmount: null };
  const sale = new Prisma.Decimal(variant.price),
    compare = new Prisma.Decimal(variant.compareAtPrice);
  if (!compare.gt(sale))
    return { effectiveCompareAtPrice: null, discountAmount: null };
  return {
    effectiveCompareAtPrice: compare.toFixed(2),
    discountAmount: compare.minus(sale).toFixed(2),
  };
}

/**
 * Why a displayed price is a range: ESTIMATE = this one price is not final;
 * BY_SLOT = the rounds of a route cost different amounts; BY_SLOT_ESTIMATE =
 * they differ and at least one of them is an estimate.
 */
export type PriceNote = 'ESTIMATE' | 'BY_SLOT' | 'BY_SLOT_ESTIMATE';
export type PriceFacts = {
  /** Exact price, or the lower bound of a range. */
  price: string | null;
  /** Upper bound; null = `price` is exact. */
  maxPrice: string | null;
  priceNote?: PriceNote;
};

const money = (value: Money) =>
  value == null ? null : new Prisma.Decimal(value).toFixed(2);

/**
 * The price of one sale: a slot's own pair when it has a price, else the
 * variant's pair. The two are never mixed, so a slot priced 350 under a
 * variant estimated 316-416 is exactly 350.
 */
export function effectivePrice(
  variant: { price: Money; maxPrice?: Money },
  slot?: { price?: Money; maxPrice?: Money } | null,
): PriceFacts {
  const pick = slot && slot.price != null ? slot : variant;
  const price = money(pick.price ?? null);
  const maxPrice = price === null ? null : money(pick.maxPrice ?? null);
  return {
    price,
    maxPrice,
    ...(maxPrice !== null ? { priceNote: 'ESTIMATE' as const } : {}),
  };
}

/** Lowest and highest price over the upcoming rounds of one variant. */
export type PriceEnvelope = {
  low: Money;
  high: Money;
  /** At least one round's price is an estimate. */
  hasEstimate: boolean;
};

/** The facts a route shows when the question names no round. */
export function envelopePrice(envelope: PriceEnvelope): PriceFacts {
  const low = money(envelope.low);
  const high = money(envelope.high);
  if (low === null) return { price: null, maxPrice: null };
  if (high === null || high === low)
    return envelope.hasEstimate
      ? { price: low, maxPrice: null, priceNote: 'ESTIMATE' }
      : { price: low, maxPrice: null };
  return {
    price: low,
    maxPrice: high,
    priceNote: envelope.hasEstimate ? 'BY_SLOT_ESTIMATE' : 'BY_SLOT',
  };
}

/**
 * Does a price (or range) fit the customer's budget? A range fits when it
 * overlaps: "ไม่เกิน 400" keeps a 316-416 round, whose text then says it is
 * an estimate, so nothing claims it is within budget for certain.
 */
export function fitsBudget(
  facts: Pick<PriceFacts, 'price' | 'maxPrice'>,
  minPrice: string | null,
  maxPrice: string | null,
): boolean {
  if (!minPrice && !maxPrice) return true;
  if (facts.price === null) return false;
  const low = new Prisma.Decimal(facts.price);
  const high = new Prisma.Decimal(facts.maxPrice ?? facts.price);
  if (maxPrice && low.gt(new Prisma.Decimal(maxPrice))) return false;
  if (minPrice && high.lt(new Prisma.Decimal(minPrice))) return false;
  return true;
}

export type PriceWording = Readonly<{
  estimate: string;
  bySlot: string;
  bySlotEstimate: string;
  certainWords: readonly string[];
}>;
/** Used when a business lexicon has no price wording of its own. */
export const DEFAULT_PRICE_WORDING: PriceWording = {
  estimate: '(ราคาโดยประมาณ)',
  bySlot: '(ราคาขึ้นกับวันและเวลา)',
  bySlotEstimate: '(ราคาขึ้นกับวันและเวลา บางรายการเป็นราคาโดยประมาณ)',
  certainWords: ['แน่นอน', 'ตายตัว', 'คงที่', 'ราคาเดียว', 'ราคาสุทธิ'],
};

/**
 * The one customer-facing text of a price: every token, safe answer and
 * timetable line goes through it, so a range always carries its note and no
 * model can show the lower bound as if it were the price.
 */
export function formatPrice(
  facts: Pick<PriceFacts, 'price'> & {
    maxPrice?: string | null;
    priceNote?: PriceNote;
  },
  wording: PriceWording = DEFAULT_PRICE_WORDING,
): string {
  if (facts.price === null) return 'ยังไม่ได้ระบุราคา';
  const note =
    facts.priceNote === 'ESTIMATE'
      ? wording.estimate
      : facts.priceNote === 'BY_SLOT'
        ? wording.bySlot
        : facts.priceNote === 'BY_SLOT_ESTIMATE'
          ? wording.bySlotEstimate
          : '';
  // No note = several exact prices (variants of one product): a plain range.
  const amount =
    facts.maxPrice == null
      ? `${facts.price} บาท`
      : `${facts.price}–${facts.maxPrice} บาท`;
  return note ? `${amount} ${note}` : amount;
}

/** CHEAPEST order: lower bound, then an exact price before a range. */
export function comparePrices(
  a: Pick<PriceFacts, 'price' | 'maxPrice'>,
  b: Pick<PriceFacts, 'price' | 'maxPrice'>,
): number {
  return (
    new Prisma.Decimal(a.price!).comparedTo(new Prisma.Decimal(b.price!)) ||
    Number(a.maxPrice !== null) - Number(b.maxPrice !== null)
  );
}

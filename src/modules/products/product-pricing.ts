import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
type Money = Prisma.Decimal | string | null;
type VariantPrice = { price: Money; compareAtPrice?: Money };
export function assertProductPricing(variants: readonly VariantPrice[]) {
  for (const variant of variants) {
    if (variant.compareAtPrice == null) continue;
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

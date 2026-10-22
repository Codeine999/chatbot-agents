import type { PrismaService } from '../../../prisma/prisma.service';
import type { CommerceScope } from '../../commerce/types/commerce-scope';
import { CreateProductDto } from '../dto/product.dto';
import type { AttributeDefinition } from '../attributes/types/attribute-definition.types';
import { catalogFields } from '../search/catalog-fields';

/** Seeds a business preset's fields for a test store, as an admin applying it would. */
export async function seedPresetFields(
  db: PrismaService,
  scope: CommerceScope,
  type: string = 'ECOMMERCE',
  categories: string[] = [],
) {
  await db.company.update({
    where: { id: scope.companyId },
    data: { productBusinessType: type, productPresetCategories: categories },
  });
}

/** In-memory definitions for pure unit tests (no DB). */
export function presetDefinitions(type = 'ECOMMERCE'): AttributeDefinition[] {
  return catalogFields(type);
}

/** Expand shared fixture defaults into explicit per-variant payloads. */
export function catalogInput(input: Record<string, unknown>): CreateProductDto {
  const { sku, basePrice, compareAtPrice, attributes, trackStock, ...product } =
    input;
  const variants = (input.variants ?? [{ sku }]) as Record<string, unknown>[];
  return CreateProductDto.schema.parse({
    ...product,
    variants: variants.map((variant) => {
      const { attributes: values, priceOverride, ...fields } = variant;
      return {
        ...fields,
        price: fields.price ?? priceOverride ?? basePrice ?? null,
        compareAtPrice: fields.compareAtPrice ?? compareAtPrice,
        trackStock: fields.trackStock ?? trackStock ?? true,
        meta: {
          ...((attributes as object) ?? {}),
          ...((values as object) ?? {}),
          ...((fields.meta as object) ?? {}),
        },
      };
    }),
  });
}

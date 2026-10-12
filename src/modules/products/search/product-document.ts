import { variantAttributes } from '../variant-business';
import { createHash } from 'node:crypto';
import { redactPii } from '../../../utils/text.utils';
import {
  formatAttributeValue,
  type AttributeDefinition,
  type AttributeScope,
} from '../attributes/attribute-definition';

export type ProductDocumentSource = {
  company?: { productBusinessType: string | null };
  name: string;
  aliases: string[];
  description: string;
  category: string | null;
  variants: ({ sku: string; meta: unknown; active: boolean } & Parameters<
    typeof variantAttributes
  >[0])[];
};

export function stableProductDescription(text: string): string {
  return redactPii(
    text.replace(
      /[^\n.!?]*(?:ราคา|บาท|สต็อก|คงเหลือ|stock|price|THB)[^\n.!?]*/giu,
      '',
    ),
  );
}

/** "label: value" pairs of the active fields allowed in `purpose`, in form order. */
export function labelledAttributes(
  definitions: readonly AttributeDefinition[],
  scope: AttributeScope,
  values: unknown,
  purpose: 'searchable' | 'aiVisible',
): { key: string; label: string; value: string }[] {
  const stored =
    values && typeof values === 'object'
      ? (values as Record<string, unknown>)
      : {};
  return definitions
    .filter((d) => d.scope === scope && d.status === 'ACTIVE' && d[purpose])
    .flatMap((d) => {
      const value = formatAttributeValue(d, stored[d.key]);
      return value ? [{ key: d.key, label: d.label, value }] : [];
    });
}

/**
 * Stable public facts only. Money/inventory/contact never enter the index, and
 * only fields the store marked searchable do; labels are included so a renamed
 * field changes the hash and is re-embedded.
 */
export function buildProductDocument(
  source: ProductDocumentSource,
  definitions: readonly AttributeDefinition[],
): string {
  const pairs = (scope: AttributeScope, values: unknown) =>
    labelledAttributes(definitions, scope, values, 'searchable').map(
      ({ label, value }) => `${label}: ${value}`,
    );
  return redactPii(
    JSON.stringify({
      name: source.name,
      aliases: source.aliases,
      description: stableProductDescription(source.description),
      category: source.category,
      variants: source.variants
        .filter((v) => v.active)
        .slice()
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .map((v) => ({
          sku: v.sku,
          options: pairs(
            'VARIANT',
            variantAttributes(v, source.company?.productBusinessType),
          ),
        })),
    }),
  );
}

export function productDocumentHash(document: string): string {
  return createHash('sha256').update(document).digest('hex');
}

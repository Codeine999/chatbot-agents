/**
 * A variant's business field values. Every business type stores them in
 * `meta`, keyed by its preset's field keys; the preset (via
 * `loadCatalogFields`) decides which keys are read and what they mean.
 */
export function variantAttributes(variant: {
  meta?: unknown;
}): Record<string, unknown> {
  return variant.meta &&
    typeof variant.meta === 'object' &&
    !Array.isArray(variant.meta)
    ? { ...(variant.meta as Record<string, unknown>) }
    : {};
}

import { z } from 'zod';

/** Where a fact applies. A fact without places applies everywhere. */
export const knowledgeMetaSchema = z.object({
  provinces: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  places: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
});

export type KnowledgeMeta = z.infer<typeof knowledgeMetaSchema>;

const normalize = (value: string) =>
  value.normalize('NFC').toLowerCase().replace(/\s+/gu, '');

/** Every province and place a fact names, as stored (for BM25 and embedding). */
export function metaPlaces(meta: unknown): string[] {
  const parsed = knowledgeMetaSchema.safeParse(meta);
  if (!parsed.success) return [];
  return [...(parsed.data.provinces ?? []), ...(parsed.data.places ?? [])];
}

type WithMeta = { metadata?: { meta?: unknown } | null };

const placesOf = (item: WithMeta) => metaPlaces(item.metadata?.meta);

/**
 * Drops facts about another place. The vocabulary is every place any known fact
 * names, so no province list is hard-coded: when the question names none of
 * them, nothing is filtered. A fact with no places always stays.
 *
 * Thai has no word gaps, so a place is found by substring on the normalised
 * question.
 */
export function filterByPlace<T extends WithMeta>(
  items: readonly T[],
  query: string,
  vocabulary: readonly unknown[] = [],
): T[] {
  const text = normalize(query);
  const known = new Set(
    [...vocabulary, ...items.map((item) => item.metadata?.meta)]
      .flatMap(metaPlaces)
      .map(normalize)
      .filter(Boolean),
  );
  const asked = [...known].filter((place) => text.includes(place));
  if (!asked.length) return [...items];

  return items.filter((item) => {
    const places = placesOf(item).map(normalize);
    if (!places.length) return true;
    return places.some((place) =>
      asked.some((name) => name === place || name.includes(place)),
    );
  });
}

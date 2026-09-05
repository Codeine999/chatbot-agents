import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAX_RETRIEVAL_CANDIDATES } from '../../../chatbot/constants/knowledge-routing.constants';

/**
 * Query-string booleans are parsed explicitly rather than with
 * `z.coerce.boolean()`, which runs JS `Boolean()` and reads the string
 * `"false"` as `true`.
 */
const booleanFlag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback)
    .transform((value) => value === 'true' || value === '1');

export class EmbeddingHealthQueryDto extends createZodDto(
  z.object({
    /**
     * Off by default so a monitor may poll this route without spending
     * credit: the shallow report answers config, billing and coverage from
     * the database alone. `deep=true` adds the provider probe and the
     * retrieval round trip, which cost one embedding call each.
     */
    deep: booleanFlag('false'),
    /**
     * Overrides the canary. Without it the round trip picks an indexed
     * pattern and asserts that pattern comes back first, which is the only
     * form of the check that can tell a working index from a wrong one.
     */
    query: z.string().trim().min(1).max(1_000).optional(),
  }),
) {}

export class EmbeddingPreviewDto extends createZodDto(
  z.object({
    text: z.string().trim().min(1).max(20_000),
    task: z
      .enum(['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT'])
      .default('RETRIEVAL_QUERY'),
    /** Leading components echoed back. The full 1536 are never returned. */
    preview: z.number().int().min(0).max(32).default(8),
  }),
) {}

export class EmbeddingSearchDto extends createZodDto(
  z.object({
    query: z.string().trim().min(1).max(1_000),
    limit: z.number().int().min(1).max(MAX_RETRIEVAL_CANDIDATES).default(5),
  }),
) {}

export class EmbeddingBackfillDto extends createZodDto(
  z.object({
    /**
     * Re-embed patterns that already carry a current vector. Off by default
     * so the usual call only pays for what is actually missing.
     */
    force: z.boolean().default(false),
    /** Caps one call so a large knowledge base can be indexed in batches. */
    limit: z.number().int().min(1).max(500).optional(),
  }),
) {}

export class EmbeddingCoverageQueryDto extends createZodDto(
  z.object({
    status: z.enum(['all', 'indexed', 'missing', 'mismatch']).default('all'),
  }),
) {}

export class EmbeddingUsageQueryDto extends createZodDto(
  z.object({
    days: z.coerce.number().int().min(1).max(90).default(7),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
) {}

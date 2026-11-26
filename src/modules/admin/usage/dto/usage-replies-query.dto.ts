import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Empty query-string values mean "not sent". */
const blank = (value: unknown) =>
  value === null || value === '' ? undefined : value;

/** Decision logs are purged after 90 days, so the channel is unknown beyond that. */
export const USAGE_REPLIES_MAX_DAYS = 90;

export class UsageRepliesQueryDto extends createZodDto(
  z.object({
    channel: z.preprocess(
      blank,
      z.enum(['LINE', 'FACEBOOK', 'APPLICATION']).optional(),
    ),
    days: z.preprocess(
      blank,
      z.coerce.number().int().min(1).max(USAGE_REPLIES_MAX_DAYS).default(30),
    ),
    page: z.preprocess(blank, z.coerce.number().int().min(1).default(1)),
    limit: z.preprocess(
      blank,
      z.coerce.number().int().min(1).max(100).default(20),
    ),
  }),
) {}

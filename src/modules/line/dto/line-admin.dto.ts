import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const optionalQueryString = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

export class GetLineMessagesQueryDto extends createZodDto(
  z.preprocess(
    (value) => value ?? {},
    z.object({
      before: optionalQueryString,
      after: optionalQueryString,
      // Id of the message at `before`/`after`, for a tie-safe keyset.
      beforeId: z.preprocess(
        (value) => (value === null || value === '' ? undefined : value),
        z.string().uuid().optional(),
      ),
      afterId: z.preprocess(
        (value) => (value === null || value === '' ? undefined : value),
        z.string().uuid().optional(),
      ),
      limit: z.preprocess(
        (value) => (value === null || value === '' ? undefined : value),
        z.coerce.number().int().min(1).max(100).optional(),
      ),
    }),
  ),
) {}

export class SendLineMessageDto extends createZodDto(
  z.object({
    text: z.string().trim().min(1).max(5000),
    clientRequestId: z.string().uuid().optional(),
  }),
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const creditsPerThb = z
  .union([z.string().trim(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^\d+(\.\d{1,6})?$/.test(value), {
    message:
      'creditsPerThb must be a positive number with at most 6 decimal places',
  })
  .refine((value) => Number(value) > 0, {
    message: 'creditsPerThb must be greater than 0',
  });

export class CreditExchangeRateDto extends createZodDto(
  z.object({ creditsPerThb }).strict(),
) {}

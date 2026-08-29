import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const priceThb = z
  .union([z.string().trim(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), {
    message: 'priceThb must be positive and have at most 2 decimal places',
  })
  .refine((value) => Number(value) > 0, {
    message: 'priceThb must be greater than 0',
  });

export class CreatePackagePriceDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(100),
      priceThb,
      popular: z.boolean().optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int().min(0).optional(),
    })
    .strict(),
) {}

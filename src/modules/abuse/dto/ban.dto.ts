import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class BanUserDto extends createZodDto(
  z.object({
    userId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    durationSec: z.coerce.number().int().positive().optional(),
  }),
) {}

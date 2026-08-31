import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class CreateSysCategoryDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(100),
    })
    .strict(),
) {}

export class SysCategoryIdParamDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
  }),
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class AdminLoginDto extends createZodDto(
  z.object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
  }),
) {}

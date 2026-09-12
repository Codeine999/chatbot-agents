import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class RegisterDto extends createZodDto(
  z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phoneNumber: z.string().regex(/^0\d{9}$/),
    bankName: z.string().trim().min(1).max(100),
    bankAccount: z.string().regex(/^\d{10,12}$/),
  }),
) {}

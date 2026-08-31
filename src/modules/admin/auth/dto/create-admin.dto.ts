import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ADMIN_ROLES } from '../../../../shared/guards/admin-auth.types';

const creditLimit = z
  .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,6})?$/)])
  .transform((value) => String(value));

export class CreateAdminDto extends createZodDto(
  z.object({
    username: z.string().trim().min(3).max(100),
    password: z.string().min(8).max(128),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(255),
    phone: z.string().trim().min(3).max(30),
    image: z.string().trim().url().nullable().optional(),
    role: z.enum(ADMIN_ROLES),
    /** Initial ADMIN_AI_QUERY allowance; omitted admin accounts start locked. */
    aiBudgetLimitCredit: creditLimit.optional(),
  }),
) {}

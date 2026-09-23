import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ADMIN_ROLES } from '../../../shared/guards/admin-auth.types';

/**
 * Every field is optional, but an empty body is rejected so a PATCH always
 * changes something. `companyId` is deliberately absent: moving an admin
 * between tenants is not an admin-console operation.
 */
export class UpdateAdminDto extends createZodDto(
  z
    .object({
      username: z.string().trim().min(3).max(100).optional(),
      password: z.string().min(8).max(128).optional(),
      firstName: z.string().trim().min(1).max(100).optional(),
      lastName: z.string().trim().min(1).max(100).optional(),
      email: z.string().trim().email().max(255).optional(),
      phone: z.string().trim().min(3).max(30).optional(),
      image: z.string().trim().url().nullable().optional(),
      role: z.enum(ADMIN_ROLES).optional(),
      aiEnabled: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
      message: 'At least one field is required',
    }),
) {}

export class AdminIdParamDto extends createZodDto(
  z.object({ id: z.string().uuid() }),
) {}

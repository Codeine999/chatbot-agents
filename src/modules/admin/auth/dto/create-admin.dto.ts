import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ADMIN_ROLES } from '../../../../infra/auth/admin-auth.types';

export class CreateAdminDto extends createZodDto(
  z.object({
    username: z.string().trim().min(3).max(100),
    password: z.string().min(8).max(128),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(255),
    phone: z.string().trim().min(3).max(30),
    picture: z.string().trim().url().nullable().optional(),
    role: z.enum(ADMIN_ROLES),
  }),
) {}

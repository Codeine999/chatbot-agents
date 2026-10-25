import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { sanitizeLine } from '../app-text';
import { appMetadataSchema } from './app-metadata';

export const createSessionSchema = z
  .object({
    displayName: z
      .string()
      .max(200)
      .transform(sanitizeLine)
      .pipe(z.string().max(50))
      .optional(),
    metadata: appMetadataSchema.optional(),
  })
  .strict();

export class CreateSessionDto extends createZodDto(createSessionSchema) {}

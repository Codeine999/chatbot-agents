import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createUploadedFileSchema } from '../../../../shared/upload/uploaded-file.schema';
import {
  COMPANY_IMAGE_ALLOWED_EXTENSIONS,
  COMPANY_IMAGE_MAX_BYTES,
  COMPANY_IMAGE_MIME_TO_EXTENSION,
} from '../company-upload.constants';

const companyNameSchema = z
  .string()
  .trim()
  .min(1, 'Company name must not be empty')
  .max(255, 'Company name must not exceed 255 characters');

const imageSchema = createUploadedFileSchema({
  maxBytes: COMPANY_IMAGE_MAX_BYTES,
  allowedExtensions: COMPANY_IMAGE_ALLOWED_EXTENSIONS,
  allowedMimeTypes: Object.keys(COMPANY_IMAGE_MIME_TO_EXTENSION),
  allowedFieldNames: ['image'],
  label: 'Image',
});

/**
 * Multipart body for a partial brand edit. `name` and `companyName` are the
 * same field — the register form already posts `companyName` — so at most one
 * may be sent. Either the name or the image may be omitted, not both.
 */
export const updateCompanySchema = z
  .object({
    name: companyNameSchema.optional(),
    companyName: companyNameSchema.optional(),
    image: imageSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.name !== undefined && value.companyName !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Send either name or companyName, not both',
      });
    }

    if (
      value.name === undefined &&
      value.companyName === undefined &&
      value.image === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Send a name, an image, or both',
      });
    }
  })
  .transform((value) => ({
    name: value.name ?? value.companyName,
    image: value.image,
  }));

export class UpdateCompanyDto extends createZodDto(updateCompanySchema) {}

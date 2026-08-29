import { extname } from 'node:path';
import { z } from 'zod';

export interface UploadedFileSchemaOptions {
  maxBytes: number;
  allowedExtensions: readonly string[];
  allowedMimeTypes: readonly string[];
  allowedFieldNames?: readonly string[];
  label?: string;
}

/**
 * Shared Zod schema factory for files already read from a multipart stream.
 * Transport limits must still be applied while reading to avoid buffering an
 * oversized upload before this schema gets a chance to reject it.
 */
export function createUploadedFileSchema(options: UploadedFileSchemaOptions) {
  const label = options.label ?? 'File';
  const allowedExtensions = new Set(
    options.allowedExtensions.map((extension) => extension.toLowerCase()),
  );
  const allowedMimeTypes = new Set(options.allowedMimeTypes);
  const allowedFieldNames = options.allowedFieldNames
    ? new Set(options.allowedFieldNames)
    : undefined;

  return z
    .object({
      fieldname: z.string().trim().min(1),
      filename: z
        .string()
        .trim()
        .min(1, `${label} filename is required`)
        .max(255, `${label} filename must not exceed 255 characters`)
        .refine((filename) => !filename.includes('\0'), {
          message: `${label} filename is invalid`,
        }),
      encoding: z.string().trim().min(1),
      mimetype: z.string().trim().min(1),
      size: z
        .number()
        .int()
        .positive(`${label} must not be empty`)
        .max(options.maxBytes, `${label} exceeds the upload size limit`),
      buffer: z.instanceof(Buffer),
    })
    .superRefine((file, context) => {
      if (allowedFieldNames && !allowedFieldNames.has(file.fieldname)) {
        context.addIssue({
          code: 'custom',
          path: ['fieldname'],
          message: `${label} must be uploaded in: ${options.allowedFieldNames!.join(', ')}`,
        });
      }

      const extension = extname(file.filename).toLowerCase();
      if (!allowedExtensions.has(extension)) {
        context.addIssue({
          code: 'custom',
          path: ['filename'],
          message: `Unsupported ${label.toLowerCase()} extension. Allowed: ${options.allowedExtensions.join(', ')}`,
        });
      }

      if (!allowedMimeTypes.has(file.mimetype)) {
        context.addIssue({
          code: 'custom',
          path: ['mimetype'],
          message: `Unsupported ${label.toLowerCase()} type. Allowed: ${options.allowedMimeTypes.join(', ')}`,
        });
      }

      if (file.buffer.length !== file.size) {
        context.addIssue({
          code: 'custom',
          path: ['size'],
          message: `${label} size does not match its content`,
        });
      }
    });
}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .nullable()
  .optional();

export class CreateImportUploadDto extends createZodDto(
  z.object({
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/\.zip$/i, 'The LINE backup is a .zip file'),
    fileSize: z.number().int().positive(),
  }),
) {}

export class PresignImportPartsDto extends createZodDto(
  z.object({
    partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
  }),
) {}

export class CompleteImportUploadDto extends createZodDto(
  z.object({
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(10_000),
          etag: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(10_000),
  }),
) {}

export class StartImportDto extends createZodDto(
  z.object({
    uploadId: z.string().uuid(),
    options: z
      .object({
        fromDate: localDate,
        toDate: localDate,
        syncFollowers: z.boolean().default(false),
        overlapMode: z.enum(['dedupe', 'skipAfterFirstLive']).default('dedupe'),
        dryRun: z.boolean().default(false),
      })
      .refine(
        (o) => !o.fromDate || !o.toDate || o.fromDate <= o.toDate,
        'fromDate must not be after toDate',
      )
      .default({ syncFollowers: false, overlapMode: 'dedupe', dryRun: false }),
  }),
) {}

export class ListImportThreadsQueryDto extends createZodDto(
  z.object({
    status: z
      .enum([
        'PENDING',
        'MATCHED_PENDING_WRITE',
        'MATERIALIZED',
        'UNMATCHED',
        'AMBIGUOUS',
        'SKIPPED',
      ])
      .optional(),
    q: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
) {}

export class PreviewImportThreadQueryDto extends createZodDto(
  z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
) {}

export class LinkImportThreadDto extends createZodDto(
  z.object({ lineMemberId: z.string().uuid() }),
) {}

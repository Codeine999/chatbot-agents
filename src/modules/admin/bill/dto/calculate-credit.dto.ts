import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Prisma } from '../../../../generated/prisma/client';

export const paidAmountSchema = z
  .union([z.string().trim(), z.number()])
  .transform((value) => String(value))
  .refine((value) => {
    try {
      const amount = new Prisma.Decimal(value);
      return (
        amount.isFinite() &&
        amount.greaterThan(0) &&
        amount.decimalPlaces() <= 6
      );
    } catch {
      return false;
    }
  }, 'paidAmount must be positive and have at most 6 decimal places');

const creditSelectionSchema = z
  .object({
    packageId: z.string().uuid().optional(),
    paidAmount: paidAmountSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Number(value.packageId !== undefined) +
        Number(value.paidAmount !== undefined) !==
      1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['packageId'],
        message: 'Send exactly one packageId or paidAmount',
      });
    }
  });

export class CalculateCreditDto extends createZodDto(creditSelectionSchema) {}

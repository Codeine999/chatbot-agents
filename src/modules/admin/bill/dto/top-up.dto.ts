import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaymentType } from '../../../../generated/prisma/client';
import { createUploadedFileSchema } from '../../../../shared/upload/uploaded-file.schema';
import {
  BILL_SLIP_ALLOWED_EXTENSIONS,
  BILL_SLIP_MAX_BYTES,
  BILL_SLIP_MIME_TO_EXTENSION,
} from '../admin-bill.constants';
import { paidAmountSchema } from './calculate-credit.dto';

const paymentTypeSchema = z
  .string()
  .trim()
  .default('Slip')
  .transform((value) => value.toLowerCase().replace(/[-_\s]/g, ''))
  .pipe(z.enum(['1', '2', 'slip', 'qrcode']))
  .transform((value) =>
    value === '1' || value === 'slip' ? PaymentType.Slip : PaymentType.QRcode,
  );

const slipSchema = createUploadedFileSchema({
  maxBytes: BILL_SLIP_MAX_BYTES,
  allowedExtensions: BILL_SLIP_ALLOWED_EXTENSIONS,
  allowedMimeTypes: Object.keys(BILL_SLIP_MIME_TO_EXTENSION),
  allowedFieldNames: ['slip', 'image'],
  label: 'Slip',
});

const topupMultipartSchema = z
  .object({
    packageId: z.string().uuid().optional(),
    paidAmount: paidAmountSchema.optional(),
    type: paymentTypeSchema,
    slip: slipSchema.optional(),
    image: slipSchema.optional(),
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

    if (
      Number(value.slip !== undefined) + Number(value.image !== undefined) !==
      1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['slip'],
        message: 'Send exactly one slip or image file',
      });
    }
  })
  .transform((value) => ({
    packageId: value.packageId,
    paidAmount: value.paidAmount,
    type: value.type,
    slip: value.slip ?? value.image!,
  }));

export class CreateTopupDto extends createZodDto(topupMultipartSchema) {}

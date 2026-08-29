import { PaymentType } from '../../../../generated/prisma/client';
import { BILL_SLIP_MAX_BYTES } from '../admin-bill.constants';
import { CreateTopupDto } from './top-up.dto';

function slip(overrides: Record<string, unknown> = {}) {
  const buffer = Buffer.from('image-content');

  return {
    fieldname: 'slip',
    filename: 'payment.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

describe('CreateTopupDto', () => {
  it('parses canonical multipart fields', () => {
    const parsed = CreateTopupDto.schema.parse({
      paidAmount: '100.123456',
      type: 'Slip',
      slip: slip(),
    });

    expect(parsed).toMatchObject({
      paidAmount: '100.123456',
      type: PaymentType.Slip,
      slip: { filename: 'payment.jpg' },
    });
  });

  it('normalizes payment type and image aliases', () => {
    const parsed = CreateTopupDto.schema.parse({
      paidAmount: '250',
      type: '2',
      image: slip({
        fieldname: 'image',
        filename: 'payment.png',
        mimetype: 'image/png',
      }),
    });

    expect(parsed.paidAmount).toBe('250');
    expect(parsed.type).toBe(PaymentType.QRcode);
    expect(parsed.slip.fieldname).toBe('image');
  });

  it('accepts packageId instead of a custom paidAmount', () => {
    const parsed = CreateTopupDto.schema.parse({
      packageId: '4c5dd593-3165-4826-b501-6ae64c900c5b',
      type: 'Slip',
      slip: slip(),
    });

    expect(parsed.packageId).toBe('4c5dd593-3165-4826-b501-6ae64c900c5b');
    expect(parsed.paidAmount).toBeUndefined();
  });

  it('rejects unsupported filenames and MIME types', () => {
    expect(() =>
      CreateTopupDto.schema.parse({
        paidAmount: '100',
        slip: slip({ filename: 'payment.exe' }),
      }),
    ).toThrow();

    expect(() =>
      CreateTopupDto.schema.parse({
        paidAmount: '100',
        slip: slip({ mimetype: 'application/pdf' }),
      }),
    ).toThrow();
  });

  it('rejects empty, oversized, and inconsistent files', () => {
    expect(() =>
      CreateTopupDto.schema.parse({
        paidAmount: '100',
        slip: slip({ size: 0, buffer: Buffer.alloc(0) }),
      }),
    ).toThrow();

    expect(() =>
      CreateTopupDto.schema.parse({
        paidAmount: '100',
        slip: slip({ size: BILL_SLIP_MAX_BYTES + 1 }),
      }),
    ).toThrow();

    expect(() =>
      CreateTopupDto.schema.parse({
        paidAmount: '100',
        slip: slip({ size: 1 }),
      }),
    ).toThrow();
  });

  it('rejects legacy credit fields and invalid paid amount precision', () => {
    expect(() =>
      CreateTopupDto.schema.parse({
        paidAmount: '100',
        creditAmount: '200',
        slip: slip(),
      }),
    ).toThrow();

    expect(() =>
      CreateTopupDto.schema.parse({
        packageId: '4c5dd593-3165-4826-b501-6ae64c900c5b',
        paidAmount: '100',
        slip: slip(),
      }),
    ).toThrow();

    expect(() =>
      CreateTopupDto.schema.parse({
        paidAmount: '0.0000001',
        slip: slip(),
      }),
    ).toThrow();
  });
});

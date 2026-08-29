import { CalculateCreditDto } from './calculate-credit.dto';

describe('CalculateCreditDto', () => {
  it.each([
    ['100', '100'],
    [100.5, '100.5'],
  ])('accepts paidAmount %p and normalizes it to %s', (input, expected) => {
    expect(
      CalculateCreditDto.schema.parse({ paidAmount: input }).paidAmount,
    ).toBe(expected);
  });

  it.each(['0', '-1', '0.0000001', 'invalid'])(
    'rejects invalid paidAmount %s',
    (paidAmount) => {
      expect(() => CalculateCreditDto.schema.parse({ paidAmount })).toThrow();
    },
  );

  it('accepts packageId and rejects packageId together with paidAmount', () => {
    const packageId = '4c5dd593-3165-4826-b501-6ae64c900c5b';

    expect(CalculateCreditDto.schema.parse({ packageId })).toEqual({
      packageId,
    });
    expect(() =>
      CalculateCreditDto.schema.parse({ packageId, paidAmount: '100' }),
    ).toThrow();
  });
});

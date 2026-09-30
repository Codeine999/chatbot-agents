import { updateCompanySchema } from './update-company.dto';

const png = (overrides: Record<string, unknown> = {}) => ({
  fieldname: 'image',
  filename: 'logo.png',
  encoding: '7bit',
  mimetype: 'image/png',
  size: 3,
  buffer: Buffer.from('png'),
  ...overrides,
});

describe('updateCompanySchema', () => {
  it('accepts a name alone, an image alone, or both', () => {
    expect(updateCompanySchema.parse({ name: '  Acme  ' })).toEqual({
      name: 'Acme',
      image: undefined,
    });
    expect(updateCompanySchema.parse({ image: png() }).image?.filename).toBe(
      'logo.png',
    );
    expect(
      updateCompanySchema.parse({ companyName: 'Acme', image: png() }).name,
    ).toBe('Acme');
  });

  it('rejects an empty body, a blank name, and both name fields', () => {
    expect(updateCompanySchema.safeParse({}).success).toBe(false);
    expect(updateCompanySchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(
      updateCompanySchema.safeParse({ name: 'A', companyName: 'B' }).success,
    ).toBe(false);
  });

  it('rejects unsupported images and unknown fields', () => {
    expect(
      updateCompanySchema.safeParse({
        image: png({ mimetype: 'image/gif', filename: 'logo.gif' }),
      }).success,
    ).toBe(false);
    expect(
      updateCompanySchema.safeParse({ name: 'A', companyType: 'shop' }).success,
    ).toBe(false);
  });
});

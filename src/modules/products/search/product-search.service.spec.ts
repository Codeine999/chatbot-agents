import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import { ProductSearchService } from './product-search.service';
import type { ProductVectorRepository } from './product-vector.repository';
import { productPlanSchema, type ProductPlan } from './product-search.types';

const companyId = '00000000-0000-4000-8000-000000000001';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Seed = {
  id: string;
  name: string;
  category: string;
  aliases: string[];
  variants: { sku: string; color: string; price: string; material: string }[];
};
const record = (p: Seed) => ({
  ...p,
  companyId,
  description: '',
  status: 'ACTIVE',
  language: 'th',
  revision: 1,
  company: { productBusinessType: 'FASHION' },
  variants: p.variants.map((v, i) => ({
    id: `${p.id.slice(0, -2)}${String(i + 1).padStart(2, '0')}`,
    sku: v.sku,
    active: true,
    price: new Prisma.Decimal(v.price),
    compareAtPrice: null,
    trackStock: true,
    inventory: { onHand: 5, reserved: 0 },
    meta: { material: v.material },
    fashion: { color: v.color, size: 'M', condition: null },
    restaurant: null,
    hotel: null,
  })),
});

const catalog = [
  record({
    id: uuid(100),
    name: 'Stussy Box Logo',
    category: 't-shirt',
    aliases: ['เสื้อยืด'],
    variants: [
      {
        sku: 'STUSSY-BOX-BK-M',
        color: 'ดำ',
        price: '2500.00',
        material: 'cotton',
      },
      {
        sku: 'STUSSY-BOX-WH-M',
        color: 'ขาว',
        price: '2700.00',
        material: 'cotton',
      },
    ],
  }),
  record({
    id: uuid(200),
    name: 'Nike Custom Tee',
    category: 't-shirt',
    aliases: ['เสื้อสั่งทำไนกี้'],
    variants: [
      {
        sku: 'NIKE-CUSTOM-BK-M',
        color: 'ดำ',
        price: '1500.00',
        material: 'cotton',
      },
    ],
  }),
  record({
    id: uuid(300),
    name: 'Stussy Oxford Shirt',
    category: 'shirt',
    aliases: ['เสื้อเชิ้ต'],
    variants: [
      {
        sku: 'STUSSY-SHIRT-BL-M',
        color: 'ฟ้า',
        price: '3500.00',
        material: 'linen 100%',
      },
    ],
  }),
  record({
    id: uuid(400),
    name: 'Supreme Work Shirt',
    category: 'shirt',
    aliases: ['เสื้อเชิ้ต'],
    variants: [
      {
        sku: 'SUPREME-SHIRT-BK-L',
        color: 'ดำ',
        price: '4200.00',
        material: 'cotton',
      },
    ],
  }),
];
type Row = (typeof catalog)[number];

type Where = {
  AND?: Where[];
  OR?: Where[];
  id?: { in?: string[]; gt?: string };
  category?: { equals?: string; contains?: string };
  name?: { contains?: string };
  aliases?: { has?: string };
};

/** Enough of Prisma's where semantics for the filters the search builds. */
function matches(row: Row, where: Where): boolean {
  const text = (
    value: string,
    filter?: { equals?: string; contains?: string },
  ) =>
    !filter ||
    (filter.equals !== undefined
      ? value.toLowerCase() === filter.equals.toLowerCase()
      : filter.contains === undefined ||
        value.toLowerCase().includes(filter.contains.toLowerCase()));
  return (
    (where.AND ?? []).every((w) => matches(row, w)) &&
    (!where.OR || where.OR.some((w) => matches(row, w))) &&
    (!where.id?.in || where.id.in.includes(row.id)) &&
    (!where.id?.gt || row.id > where.id.gt) &&
    text(row.category, where.category) &&
    text(row.name, where.name) &&
    (!where.aliases?.has || row.aliases.includes(where.aliases.has))
  );
}

function setup(
  options: {
    probe?: Row[];
    lexical?: { id: string; hits: number }[];
  } = {},
) {
  const sql: string[] = [];
  const queryRaw = jest.fn((first: TemplateStringsArray | Prisma.Sql) => {
    const text = Array.isArray(first)
      ? first.join('?')
      : (first as Prisma.Sql).sql;
    sql.push(text);
    if (text.includes('array_agg(v.sku'))
      return Promise.resolve(
        (options.probe ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          aliases: p.aliases,
          skus: p.variants.map((v) => v.sku),
          variantIds: p.variants.map((v) => v.id),
        })),
      );
    if (text.includes('AS hits')) return Promise.resolve(options.lexical ?? []);
    // Aggregate subject: products whose identity contains every term.
    return Promise.resolve([]);
  });
  const tx = {
    $queryRaw: queryRaw,
    company: {
      findUnique: jest.fn().mockResolvedValue({
        productBusinessType: 'FASHION',
        productPresetCategories: [],
      }),
    },
    product: {
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(catalog.filter((row) => matches(row, where))),
      ),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(catalog.find((row) => matches(row, where)) ?? null),
      ),
    },
  };
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;
  const vectors = { search: jest.fn() } as unknown as ProductVectorRepository;
  const service = new ProductSearchService(prisma, vectors);
  return {
    sql,
    search: (plan: Partial<ProductPlan>) =>
      service.search(
        { companyId },
        productPlanSchema.parse({ mode: 'PRODUCT', query: '', ...plan }),
      ),
  };
}

describe('ProductSearchService', () => {
  it('asks which product when the question names nothing (F32)', async () => {
    const { search, sql } = setup();
    const result = await search({
      query: 'ราคาเท่าไรคะ',
      asks: ['PRICE'],
      ambiguous: true,
    });
    expect(result).toMatchObject({ status: 'MISSING_INPUT', choices: [] });
    expect(sql.some((text) => text.includes('ORDER BY ('))).toBe(false);
  });

  it('answers every variant of one named product even when marked ambiguous (F07)', async () => {
    const { search } = setup({ probe: [catalog[0]] });
    const result = await search({
      query: 'Stussy Box Logo',
      asks: ['PRICE'],
      ambiguous: true,
    });
    expect(result.status).toBe('FOUND');
    expect(result.evidence.map((e) => e.price)).toEqual(['2500.00', '2700.00']);
  });

  it('still asks when several candidates stay ambiguous', async () => {
    const { search } = setup();
    const result = await search({
      productIds: [catalog[0].id, catalog[1].id],
      ambiguous: true,
    });
    expect(result.status).toBe('MISSING_INPUT');
    expect(result.choices).toHaveLength(2);
  });

  it('resolves a name tie with the variant constraint (F19)', async () => {
    const { search } = setup({
      lexical: [
        { id: catalog[2].id, hits: 1 },
        { id: catalog[3].id, hits: 1 },
      ],
    });
    const result = await search({
      query: 'เสื้อเชิ้ต',
      filters: [{ key: 'material', operator: 'CONTAINS', value: 'linen' }],
    });
    expect(result.status).toBe('FOUND');
    expect(result.evidence.map((e) => e.name)).toEqual(['Stussy Oxford Shirt']);
  });

  it('filters the catalog by constraints without a subject', async () => {
    const { search, sql } = setup();
    const result = await search({ maxPrice: '2000' });
    expect(result.status).toBe('FOUND');
    expect(result.evidence.map((e) => e.sku)).toEqual(['NIKE-CUSTOM-BK-M']);
    expect(sql.some((text) => text.includes('ORDER BY ('))).toBe(false);
  });

  it('lists a store category exactly, including products without the alias (F02)', async () => {
    const { search } = setup();
    const tees = await search({ operation: 'LIST', category: 't-shirt' });
    expect(new Set(tees.evidence.map((e) => e.name))).toEqual(
      new Set(['Stussy Box Logo', 'Nike Custom Tee']),
    );
    const shirts = await search({ operation: 'LIST', category: 'shirt' });
    expect(new Set(shirts.evidence.map((e) => e.name))).toEqual(
      new Set(['Stussy Oxford Shirt', 'Supreme Work Shirt']),
    );
  });
});

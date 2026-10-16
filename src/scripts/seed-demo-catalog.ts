/**
 * Adds a small Thai demo catalog (codes prefixed DEMO-) through the real
 * catalog services: FASHION preset fields, products, variants and stock
 * adjustments with their audit movements.
 *
 *   npm run seed:demo-catalog
 *
 * Every command uses a fixed request ID, so a rerun replays the stored
 * results instead of creating duplicates. The catalog flag is enabled for
 * this process only; .env and the LINE bot behaviour are not changed.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CommerceFeatureService } from '../modules/commerce/commerce-feature.service';
import { CommerceScopeService } from '../modules/commerce/commerce-scope.service';
import { ProductCommandService } from '../modules/products/product-command.service';
import { ProductService } from '../modules/products/product.service';
import { InventoryService } from '../modules/products/inventory.service';
import { ProductAttributeService } from '../modules/products/attributes/product-attribute.service';
import { ProductSearchService } from '../modules/products/search/product-search.service';
import { ProductVectorRepository } from '../modules/products/search/product-vector.repository';
import { productPlanSchema } from '../modules/products/search/product-search.types';
import type { CreateProductDto } from '../modules/products/dto/product.dto';

/** Stable RFC 4122 v4-shaped ID per step, so reruns replay instead of duplicating. */
function requestId(step: string): string {
  const h = createHash('sha256').update(`demo-catalog:${step}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type DemoVariant = {
  sku: string;
  color?: string;
  size?: string;
  priceOverride?: string;
  stock?: number;
};
type DemoProduct = {
  sku: string;
  name: string;
  category: string;
  aliases?: string[];
  description: string;
  basePrice: string;
  trackStock?: boolean;
  attributes: Record<string, string | string[]>;
  variants: DemoVariant[];
};

const CATALOG: DemoProduct[] = [
  {
    sku: 'DEMO-LIN-LONG',
    name: 'เสื้อเชิ้ตลินินแขนยาว',
    category: 'เสื้อผ้า',
    description:
      'ผ้าลินินแท้ ระบายอากาศดี เหมาะกับอากาศร้อน ใส่ทำงานหรือเที่ยวได้',
    basePrice: '590.00',
    attributes: { brand: 'Keela Basic', material: 'ลินิน', tags: ['ขายดี'] },
    variants: [
      { sku: 'DEMO-LIN-LONG-BK-M', color: 'ดำ', size: 'M', stock: 4 },
      { sku: 'DEMO-LIN-LONG-BK-L', color: 'ดำ', size: 'L', stock: 2 },
      {
        sku: 'DEMO-LIN-LONG-WH-M',
        color: 'ขาว',
        size: 'M',
        priceOverride: '620.00',
        stock: 3,
      },
    ],
  },
  {
    sku: 'DEMO-LIN-SHORT',
    name: 'เสื้อเชิ้ตลินินแขนสั้น',
    category: 'เสื้อผ้า',
    description: 'ทรงสบาย เนื้อผ้าบางเบา',
    basePrice: '490.00',
    attributes: { brand: 'Keela Basic', material: 'ลินิน' },
    variants: [
      { sku: 'DEMO-LIN-SHORT-WH-M', color: 'ขาว', size: 'M', stock: 5 },
      { sku: 'DEMO-LIN-SHORT-WH-L', color: 'ขาว', size: 'L', stock: 0 },
    ],
  },
  {
    sku: 'DEMO-TEE',
    name: 'เสื้อยืดคอตตอน',
    category: 'เสื้อผ้า',
    aliases: ['เสื้อยืด'],
    description: 'ผ้าฝ้ายนุ่ม ไม่ยับง่าย ซักเครื่องได้',
    basePrice: '199.00',
    attributes: {
      brand: 'Keela Basic',
      material: 'คอตตอน 100%',
      tags: ['ใหม่'],
    },
    variants: [
      { sku: 'DEMO-TEE-BK-S', color: 'ดำ', size: 'S', stock: 9 },
      { sku: 'DEMO-TEE-BK-M', color: 'ดำ', size: 'M', stock: 9 },
      { sku: 'DEMO-TEE-WH-L', color: 'ขาว', size: 'L', stock: 0 },
    ],
  },
  {
    sku: 'DEMO-JEANS',
    name: 'กางเกงยีนส์ขาตรง',
    category: 'เสื้อผ้า',
    description: 'ยีนส์ผ้าหนา ทรงขาตรงใส่ได้ทุกวัน',
    basePrice: '890.00',
    attributes: { brand: 'Denim Lab', material: 'ยีนส์' },
    variants: [
      { sku: 'DEMO-JEANS-30', size: '30', stock: 3 },
      { sku: 'DEMO-JEANS-32', size: '32', stock: 1 },
    ],
  },
  {
    sku: 'DEMO-RUN',
    name: 'รองเท้าวิ่ง AirLite',
    category: 'รองเท้า',
    description: 'น้ำหนักเบา พื้นนุ่ม เหมาะกับวิ่งระยะกลาง',
    basePrice: '1590.00',
    attributes: { brand: 'AirLite', tags: ['วิ่ง'] },
    variants: [
      { sku: 'DEMO-RUN-41', size: '41', stock: 1 },
      { sku: 'DEMO-RUN-42', size: '42', stock: 0 },
    ],
  },
  {
    sku: 'DEMO-SANDAL',
    name: 'รองเท้าแตะยาง',
    category: 'รองเท้า',
    description: 'ยางนิ่ม กันลื่น',
    basePrice: '159.00',
    attributes: {},
    variants: [{ sku: 'DEMO-SANDAL-40', size: '40', stock: 6 }],
  },
  {
    sku: 'DEMO-CAP',
    name: 'หมวกแก๊ปผ้าฝ้าย',
    category: 'หมวก',
    description: 'ปรับขนาดได้ด้วยสายด้านหลัง',
    basePrice: '250.00',
    trackStock: false,
    attributes: { material: 'ผ้าฝ้าย' },
    variants: [{ sku: 'DEMO-CAP-FREE', size: 'Free Size' }],
  },
];

async function main(): Promise<void> {
  const config = new ConfigService({
    ...process.env,
    PRODUCT_ENABLED: 'true',
    PRODUCT_RAG_ENABLED: 'false',
    PRODUCT_SEMANTIC_ENABLED: 'false',
  });
  const prisma = new PrismaService(config);
  await prisma.$connect();
  try {
    const features = new CommerceFeatureService(config);
    const commands = new ProductCommandService(prisma);
    const scope = await new CommerceScopeService(
      prisma,
      config,
    ).forLineDeployment();
    const actor = await prisma.adminMember.findFirst({
      where: {
        OR: [{ companyId: scope.companyId }, { companyId: null }],
        role: { in: ['owner', 'admin', 'dev'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!actor) throw new Error('No owner/admin/dev for this company');

    const fields = new ProductAttributeService(prisma, commands, features);
    const preset = await fields.applyPreset(scope, actor.id, 'FASHION', {
      requestId: requestId('preset:FASHION'),
      categories: [],
    });
    console.log(
      `FASHION fields: created [${preset.fields.map((f) => f.key).join(', ')}]`,
    );

    const catalog = new ProductService(prisma, commands, features, config);
    const inventory = new InventoryService(commands, features);
    for (const item of CATALOG) {
      const product = await catalog.create(scope, actor.id, {
        requestId: requestId(`product:${item.sku}`),
        name: item.name,
        category: item.category,
        aliases: item.aliases ?? [],
        description: item.description,
        status: 'ACTIVE',
        variants: item.variants.map((v) => ({
          sku: v.sku,
          meta: {
            ...item.attributes,
            ...(v.color ? { color: v.color } : {}),
            ...(v.size ? { size: v.size } : {}),
          },
          price: v.priceOverride ?? item.basePrice,
          trackStock: item.trackStock ?? true,
          active: true,
        })),
      } as unknown as CreateProductDto);
      for (const v of item.variants) {
        if (!v.stock || item.trackStock === false) continue;
        const variant = product.variants.find((r) => r.sku === v.sku)!;
        await inventory.adjust(scope, actor.id, product.id, variant.id, {
          requestId: requestId(`stock:${v.sku}`),
          expectedVersion: 1,
          deltaOnHand: v.stock,
          reason: 'ตั้งสต็อกเริ่มต้นของข้อมูลทดสอบ',
        });
      }
      console.log(`product ${item.sku}: ${product.variants.length} variants`);
    }

    // Read back through product search, the path the bot uses.
    const search = new ProductSearchService(
      prisma,
      new ProductVectorRepository(prisma),
      config,
    );
    const checks: [string, Record<string, unknown>][] = [
      ['เสื้อยืดราคาเท่าไร', { asks: ['PRICE'] }],
      [
        'เสื้อยืดสีดำไซส์ M มีของไหม',
        {
          options: [
            { key: 'color', value: 'ดำ' },
            { key: 'size', value: 'M' },
          ],
          asks: ['STOCK'],
        },
      ],
      ['เสื้อลินินราคาเท่าไร', { asks: ['PRICE'] }],
      ['รองเท้าที่ถูกที่สุด', { operation: 'CHEAPEST' }],
      ['มีสินค้ากี่ชนิด', { operation: 'COUNT' }],
    ];
    const rows: Record<string, string | number>[] = [];
    for (const [query, fieldsInput] of checks) {
      const result = await search.search(
        scope,
        productPlanSchema.parse({ mode: 'PRODUCT', query, ...fieldsInput }),
      );
      rows.push({
        query,
        status: result.status,
        total: result.total ?? '',
        result: result.evidence.length
          ? result.evidence
              .slice(0, 3)
              .map(
                (e) =>
                  `${e.sku} ${e.price ?? '-'}฿ ${e.stock} [${e.options.map((o) => o.value).join('/')}]`,
              )
              .join(' | ')
          : result.choices.map((c) => c.name).join(' / '),
      });
    }
    console.table(rows);

    const where = { companyId: scope.companyId };
    console.log({
      products: await prisma.product.count({ where }),
      variants: await prisma.productVariant.count({ where }),
      inventoryBalances: await prisma.inventoryBalance.count({ where }),
      inventoryMovements: await prisma.inventoryMovement.count({ where }),
      catalogCommands: await prisma.productCatalogCommand.count({ where }),
    });
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import {
  productPlanSchema,
  type ProductEvidence,
  type ProductPlan,
  type ProductWorkflow,
} from '../../../products/search/product-search.types';
import {
  presentedProductRefs,
  renderProductAnswer,
  safeProductAnswer,
} from './product-answer.policy';

const companyId = '00000000-0000-4000-8000-000000000001';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Variant = {
  sku: string;
  color: string;
  size: string;
  price: string;
  stock: number;
};
function evidence(
  productId: string,
  name: string,
  material: string,
  variants: Variant[],
): ProductEvidence[] {
  return variants.map((v, i) => ({
    ref: `PRODUCT:${productId}-${i}`,
    productId,
    variantId: `${productId}-${i}`,
    name,
    category: 'เสื้อ',
    aliases: [],
    sku: v.sku,
    description: '',
    details: [{ key: 'material', label: 'เนื้อผ้า', value: material }],
    options: [
      { key: 'color', label: 'สี', value: v.color },
      { key: 'size', label: 'ไซส์', value: v.size },
    ],
    price: v.price,
    currency: 'THB',
    stock: v.stock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
    onHand: v.stock,
    reserved: 0,
    availableStock: v.stock,
    purchasable: v.stock > 0,
    fetchedAt: '2026-10-14T00:00:00.000Z',
    sourceRevision: 1,
  }));
}

const linen = evidence(uuid(10), 'เสื้อเชิ้ตลินินแขนยาว', 'ลินิน 100%', [
  {
    sku: 'LIN-SHIRT-CR-M',
    color: 'ครีม',
    size: 'M',
    price: '720.00',
    stock: 2,
  },
  { sku: 'LIN-SHIRT-WH-L', color: 'ขาว', size: 'L', price: '690.00', stock: 0 },
  { sku: 'LIN-SHIRT-WH-M', color: 'ขาว', size: 'M', price: '690.00', stock: 5 },
  { sku: 'LIN-SHIRT-WH-S', color: 'ขาว', size: 'S', price: '690.00', stock: 3 },
]);
const oversizeL = evidence(
  uuid(20),
  'เสื้อยืดโอเวอร์ไซส์',
  'คอตตอน 100% หนา 240 แกรม',
  [
    { sku: 'TEE-OVS-BK-L', color: 'ดำ', size: 'L', price: '290.00', stock: 6 },
    { sku: 'TEE-OVS-GY-L', color: 'เทา', size: 'L', price: '290.00', stock: 4 },
  ],
);
const cropPinkS = evidence(
  uuid(30),
  'เสื้อยืดครอป',
  'คอตตอนผสมสแปนเด็กซ์ ยืดได้',
  [
    {
      sku: 'TEE-CROP-PK-S',
      color: 'ชมพู',
      size: 'S',
      price: '250.00',
      stock: 3,
    },
  ],
);

function workflow(
  rows: ProductEvidence[],
  plan: Partial<ProductPlan>,
  identified = true,
): ProductWorkflow {
  return {
    turnId: uuid(99),
    scope: { companyId },
    plan: productPlanSchema.parse({ mode: 'PRODUCT', query: '', ...plan }),
    result: {
      status: 'FOUND',
      businessType: 'FASHION',
      evidence: rows,
      choices: [],
      identified,
    },
  };
}
const answer = (template: string, refs: readonly ProductEvidence[]) =>
  JSON.stringify({
    decision: 'ANSWER',
    directlyAnswered: true,
    answerTemplate: template,
    evidenceIds: refs.map((e) => e.ref),
  });

describe('product answer grounding', () => {
  describe('attribute questions (C01, crop)', () => {
    const asked = workflow([linen[2]], {
      query: 'เสื้อเชิ้ตลินินแขนยาว',
      options: [
        { key: 'color', value: 'ขาว' },
        { key: 'size', value: 'M' },
      ],
      asks: ['ATTRIBUTES'],
    });

    it('rejects a material written as prose instead of the stored detail', () => {
      expect(
        renderProductAnswer(
          answer('{{e1.name}} ตัดจากผ้าไหมแท้ เนื้อเงางามค่ะ', [linen[2]]),
          asked,
          [],
        ),
      ).toBeUndefined();
    });

    it('accepts the stored detail token', () => {
      expect(
        renderProductAnswer(
          answer('{{e1.name}} เนื้อผ้า {{e1.attr.material}} ค่ะ', [linen[2]]),
          asked,
          [],
        ),
      ).toBe('เสื้อเชิ้ตลินินแขนยาว เนื้อผ้า ลินิน 100% ค่ะ');
    });

    it('safe fallback answers the asked details from the catalog', () => {
      const text = safeProductAnswer(asked, []);
      expect(text).toContain('ลินิน 100%');
      expect(text).not.toContain('ผ้าไหม');
      const crop = safeProductAnswer(
        workflow(cropPinkS, {
          query: 'เสื้อยืดครอป',
          options: [
            { key: 'color', value: 'ชมพู' },
            { key: 'size', value: 'S' },
          ],
          asks: ['ATTRIBUTES'],
        }),
        [],
      );
      expect(crop).toContain('คอตตอนผสมสแปนเด็กซ์');
    });

    it('lists details shared by variants once', () => {
      const text = safeProductAnswer(
        workflow(linen, {
          query: 'เสื้อเชิ้ตลินินแขนยาว',
          asks: ['ATTRIBUTES'],
        }),
        [],
      );
      expect(text.match(/ลินิน 100%/g)).toHaveLength(1);
    });
  });

  describe('option values in prose (C02)', () => {
    const asked = workflow(oversizeL, {
      query: 'เสื้อยืดโอเวอร์ไซส์',
      options: [{ key: 'size', value: 'L' }],
      asks: ['PRICE'],
    });

    it('rejects a colour the customer did not choose', () => {
      expect(
        renderProductAnswer(
          answer(
            '{{e1.name}} สีขาว ไซส์ {{e1.opt.size}} ราคา {{e1.price}} ค่ะ',
            [oversizeL[0]],
          ),
          asked,
          [],
        ),
      ).toBeUndefined();
      // A real evidence value is still a claim about one variant only.
      expect(
        renderProductAnswer(
          answer('{{e1.name}} สีดำ ราคา {{e1.price}} ค่ะ', [oversizeL[0]]),
          asked,
          [],
        ),
      ).toBeUndefined();
    });

    it('allows the value the customer chose and option tokens', () => {
      expect(
        renderProductAnswer(
          answer('{{e1.name}} ไซส์ L ราคา {{e1.price}} ค่ะ', [oversizeL[0]]),
          asked,
          [],
        ),
      ).toBe('เสื้อยืดโอเวอร์ไซส์ ไซส์ L ราคา 290.00 บาท ค่ะ');
      expect(
        renderProductAnswer(
          answer(
            '{{e1.name}} ไซส์ L มีสี {{e1.opts.color}} ราคา {{e1.price}} ค่ะ',
            [oversizeL[0]],
          ),
          asked,
          [],
        ),
      ).toBe('เสื้อยืดโอเวอร์ไซส์ ไซส์ L มีสี ดำ, เทา ราคา 290.00 บาท ค่ะ');
    });
  });

  describe('price of every variant (C04)', () => {
    const asked = workflow(linen, {
      query: 'เสื้อเชิ้ตลินินแขนยาว',
      asks: ['PRICE'],
    });

    it('rejects one price when variants differ', () => {
      expect(
        renderProductAnswer(
          answer('{{e3.name}} ราคา {{e3.price}} ค่ะ', [linen[2]]),
          asked,
          [],
        ),
      ).toBeUndefined();
    });

    it('accepts the price range and presents every variant', () => {
      const raw = answer('{{e1.name}} ราคา {{e1.priceRange}} ค่ะ', [linen[0]]);
      expect(renderProductAnswer(raw, asked, [])).toBe(
        'เสื้อเชิ้ตลินินแขนยาว ราคา 690.00–720.00 บาท ค่ะ',
      );
      expect(presentedProductRefs(raw, asked)).toHaveLength(linen.length);
    });

    it('accepts each distinct price shown with its variant', () => {
      expect(
        renderProductAnswer(
          answer(
            '{{e1.name}} สี {{e1.opt.color}} ราคา {{e1.price}} สี {{e3.opt.color}} ราคา {{e3.price}} ค่ะ',
            [linen[0], linen[2]],
          ),
          asked,
          [],
        ),
      ).toBe(
        'เสื้อเชิ้ตลินินแขนยาว สี ครีม ราคา 720.00 บาท สี ขาว ราคา 690.00 บาท ค่ะ',
      );
    });

    it('safe fallback shows every price', () => {
      const text = safeProductAnswer(asked, []);
      expect(text).toContain('720.00');
      expect(text).toContain('690.00');
    });

    it('cheapest shows only the lowest price', () => {
      expect(
        renderProductAnswer(
          answer('{{e1.name}} ราคา {{e1.price}} ค่ะ', [linen[1]]),
          workflow(
            [linen[1], linen[2], linen[3], linen[0]],
            { query: 'เสื้อ', operation: 'CHEAPEST', asks: ['PRICE'] },
            false,
          ),
          [],
        ),
      ).toBe('เสื้อเชิ้ตลินินแขนยาว ราคา 690.00 บาท ค่ะ');
    });
  });
});

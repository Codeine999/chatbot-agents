import type {
  BusinessCapabilities,
  BusinessLexicon,
} from '../types/attribute-definition.types';

/** Stock per variant: the behavior every store had before presets carried capabilities. */
export const ECOMMERCE_CAPABILITIES: BusinessCapabilities = {
  inventory: 'VARIANT_STOCK',
  showQuantity: true,
  lowThreshold: null,
  maxQuantity: 50,
};

/**
 * ECOMMERCE wording. Every value is the text that used to be hardcoded in the
 * product router, answer policy and prompts, copied character for character
 * (the SUBSTRING entries are the original regex alternatives).
 */
export const ECOMMERCE_LEXICON: BusinessLexicon = {
  matchMode: 'SUBSTRING',
  itemNoun: 'สินค้า',
  unit: 'ชิ้น',
  availability: {
    AVAILABLE: 'มีสินค้าคงเหลือ ณ เวลาตรวจสอบ',
    LOW: 'มีสินค้าคงเหลือ ณ เวลาตรวจสอบ',
    FULL: 'สินค้าหมด ณ เวลาตรวจสอบ',
    CLOSED: 'สินค้าหมด ณ เวลาตรวจสอบ',
    UNKNOWN: 'ยังตรวจสอบสต็อกไม่ได้',
    NOT_TRACKED:
      'ร้านไม่ได้เปิดระบบติดตามสต็อก กรุณาสอบถามเจ้าหน้าที่เพื่อยืนยัน',
  },
  clarify: {
    which:
      'หมายถึงสินค้ารุ่นไหนคะ: {choices} หรือระบุสีและขนาดที่ต้องการได้ค่ะ',
    none: 'สนใจสินค้าประเภทไหนหรือรุ่นไหนคะ?',
    unavailable: 'ขณะนี้ยังตรวจสอบข้อมูลสินค้าไม่ได้ กรุณาสอบถามเจ้าหน้าที่ค่ะ',
    notFound:
      'ยังไม่พบข้อมูลสินค้าที่ตรงกับคำถาม กรุณาระบุชื่อรุ่นหรือ SKU เพิ่มเติมค่ะ',
    unmatched: 'ยังไม่พบสินค้าที่ตรงกับคำถามนี้ค่ะ',
    unmatchedNear: '\nสินค้าที่ใกล้เคียง: {names} สนใจตัวไหนแจ้งได้เลยค่ะ',
  },
  entityMarkers: ['รุ่น', 'model'],
  signals: [
    'ราคา',
    'สินค้า',
    'รุ่น',
    'สี',
    'ไซ[ซส]',
    'ขนาด',
    'สต็อก',
    'มีของ',
    'ซื้อ',
    'อยากได้',
    'แนะนำ',
    'เสื้อ',
    'รองเท้า',
    'stock',
    'product',
    'sku',
  ],
  policySignals: [
    'ส่งฟรี',
    'ค่าส่ง',
    'จัดส่ง',
    'คืนสินค้า',
    'รับประกัน',
    'วิธีสมัคร',
    'นโยบาย',
    'shipping',
    'return policy',
  ],
  referenceSignals: [
    'ตัวนี้',
    'ตัวนั้น',
    'เมื่อกี้',
    'อันนี้',
    'อันนั้น',
    'ตัวแรก',
    'ตัวที่',
    'สีดำ',
    'สีขาว',
    'แล้ว.*(?:ราคา|สี|ไซ)',
  ],
  askSignals: {
    PRICE: ['ราคา', 'เท่าไร', 'เท่าไหร่', 'price'],
    STOCK: ['มีของ', 'สต็อก', 'พร้อมส่ง', 'หมด', 'เหลือ', 'stock'],
  },
  broadInquiry: [
    '^(?:ขอ|อยาก|ต้องการ)?(?:สอบถาม|ถาม|สนใจ)(?:เกี่ยวกับ|เรื่อง)?สินค้า(?:หน่อย)?(?:ครับ|ค่ะ|คะ|คับ)?[?？!]*$',
  ],
  standalonePolicyQuestions: [
    '^(?:ส่งฟรีไหม|ค่าส่งเท่าไร|ค่าส่งเท่าไหร่|จัดส่งกี่วัน|คืนสินค้าได้ไหม|มีรับประกันไหม)(?:ครับ|ค่ะ|คะ|คับ)?[?？]*$',
  ],
  claimWords: [
    'มีของ',
    'มีสินค้า',
    'พร้อมส่ง',
    'สินค้าหมด',
    'หมดสต็อก',
    'เหลือ\\s',
    'ส่งฟรี',
    'free shipping',
    'in stock',
    'out of stock',
  ],
  questionWords: [],
};

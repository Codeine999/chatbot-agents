/**
 * Synthetic fashion store for the live product audit ("Mira Closet").
 * Everything is seeded through the real services an admin would use:
 * FASHION preset fields, catalog commands, stock adjustments, knowledge
 * create (with real embeddings), product indexing, and a real top-up approval.
 * The audit runs it only against a disposable database.
 *
 * Each product exists to exercise a state the product flow can reach:
 * price override, out-of-stock variant, untracked stock, missing stock row,
 * missing price, two products sharing a word (ambiguity), a draft product that
 * must never be offered, and enough tops to truncate a list.
 */
import { randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CompanyService } from '../../src/modules/admin/company/company.service';
import { AdminBillService } from '../../src/modules/admin/bill/admin-bill.service';
import type { FileStorageService } from '../../src/infra/storage/file-storage.service';
import { AiPricingCatalogService } from '../../src/modules/admin/pricing/ai-pricing-catalog.service';
import { AiProviderSettingsService } from '../../src/modules/ai/ai-provider-settings.service';
import type { AiProviderName } from '../../src/ai-provider/types/ai-provider.types';
import { EmbeddingService } from '../../src/modules/ai/embeding/embedding.service';
import { AnswerPatternVectorRepository } from '../../src/modules/ai/embeding/answer-pattern-vector.repository';
import { MicroKnowledgeVectorRepository } from '../../src/modules/ai/embeding/micro-knowledge-vector.repository';
import { AnswerPatternCacheService } from '../../src/modules/chatbot/knowledge/answer-pattern-cache.service';
import { AdminKnowledgePatternService } from '../../src/modules/admin/knowledge/admin-knowledge-pattern.service';
import { AdminKnowledgeMicroService } from '../../src/modules/admin/knowledge/admin-knowledge-micro.service';
import type { CreateAdminAnswerPatternDto } from '../../src/modules/admin/knowledge/dto/admin-answer-pattern.dto';
import type { CreateAdminMicroKnowledgeDto } from '../../src/modules/admin/knowledge/dto/admin-micro-knowledge.dto';
import { ProductAttributeService } from '../../src/modules/products/attributes/product-attribute.service';
import { ProductService } from '../../src/modules/products/product.service';
import { InventoryService } from '../../src/modules/products/inventory.service';
import { ProductIndexService } from '../../src/modules/products/search/product-index.service';
import type { CreateProductDto } from '../../src/modules/products/dto/product.dto';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/modules/chatbot/constants/ai-chat.constants';

export const STORE_NAME = 'Mira Closet';
export const FALLBACK_MESSAGE =
  'ขออภัยค่ะ เรื่องนี้ขอให้แอดมินตรวจสอบและตอบกลับโดยเร็วนะคะ 🙏';
const OWNER_PROMPT = `คุณคือแอดมินร้าน ${STORE_NAME} ร้านเสื้อผ้าผู้หญิงออนไลน์บน LINE
พูดสุภาพ เป็นกันเอง ลงท้ายด้วย "ค่ะ" ตอบสั้นกระชับแบบแชท ไม่ใช้ภาษาทางการเกินไป`;

type SeedVariant = {
  sku: string;
  color?: string;
  size?: string;
  priceOverride?: string;
  stock?: number;
};
export type SeedProduct = {
  sku: string;
  name: string;
  category: string;
  aliases?: string[];
  description: string;
  basePrice: string | null;
  status?: 'ACTIVE' | 'DRAFT';
  trackStock?: boolean;
  /** Delete the stock row after create: a tracked product with no balance is UNKNOWN. */
  dropStockRow?: boolean;
  attributes: Record<string, string | string[]>;
  variants: SeedVariant[];
};

export const CATALOG: SeedProduct[] = [
  {
    sku: 'LIN-SHIRT',
    name: 'เสื้อเชิ้ตลินินแขนยาว',
    category: 'เสื้อ',
    aliases: ['เชิ้ตลินิน'],
    description:
      'เสื้อเชิ้ตผ้าลินินแท้ ทรงหลวม ระบายอากาศดี ใส่ทำงานหรือเที่ยวทะเลได้',
    basePrice: '690.00',
    attributes: {
      brand: 'Mira Basic',
      material: 'ลินิน 100%',
      tags: ['ขายดี'],
    },
    variants: [
      { sku: 'LIN-SHIRT-WH-S', color: 'ขาว', size: 'S', stock: 3 },
      { sku: 'LIN-SHIRT-WH-M', color: 'ขาว', size: 'M', stock: 5 },
      { sku: 'LIN-SHIRT-WH-L', color: 'ขาว', size: 'L', stock: 0 },
      {
        sku: 'LIN-SHIRT-CR-M',
        color: 'ครีม',
        size: 'M',
        priceOverride: '720.00',
        stock: 2,
      },
    ],
  },
  {
    sku: 'TEE-OVS',
    name: 'เสื้อยืดโอเวอร์ไซส์',
    category: 'เสื้อ',
    aliases: ['เสื้อโอเวอร์ไซส์', 'oversize tee'],
    description:
      'เสื้อยืดทรงโอเวอร์ไซส์ ผ้าคอตตอนหนานุ่ม ไม่ย้วยง่าย ซักเครื่องได้',
    basePrice: '290.00',
    attributes: { brand: 'Mira Basic', material: 'คอตตอน 100% หนา 240 แกรม' },
    variants: [
      { sku: 'TEE-OVS-BK-M', color: 'ดำ', size: 'M', stock: 8 },
      { sku: 'TEE-OVS-BK-L', color: 'ดำ', size: 'L', stock: 6 },
      { sku: 'TEE-OVS-BK-XL', color: 'ดำ', size: 'XL', stock: 2 },
      { sku: 'TEE-OVS-WH-M', color: 'ขาว', size: 'M', stock: 0 },
      { sku: 'TEE-OVS-GY-L', color: 'เทา', size: 'L', stock: 4 },
    ],
  },
  {
    sku: 'TEE-CROP',
    name: 'เสื้อยืดครอป',
    category: 'เสื้อ',
    aliases: ['ครอปท็อป'],
    description: 'เสื้อยืดครอปเอวลอย ผ้ายืดกระชับ',
    basePrice: '250.00',
    attributes: { material: 'คอตตอนผสมสแปนเด็กซ์ ยืดได้' },
    variants: [
      { sku: 'TEE-CROP-BK-S', color: 'ดำ', size: 'S', stock: 5 },
      { sku: 'TEE-CROP-PK-S', color: 'ชมพู', size: 'S', stock: 3 },
      { sku: 'TEE-CROP-PK-M', color: 'ชมพู', size: 'M', stock: 1 },
    ],
  },
  {
    sku: 'DRESS-FLR',
    name: 'เดรสลายดอกแขนตุ๊กตา',
    category: 'เดรส',
    aliases: ['เดรสลายดอก'],
    description:
      'เดรสยาวคลุมเข่า ลายดอกไม้โทนพาสเทล แขนตุ๊กตา มีซับในไม่โป๊ เหมาะใส่เที่ยวทะเลและงานเลี้ยงกลางวัน',
    basePrice: '890.00',
    attributes: {
      brand: 'Mira Studio',
      material: 'ชีฟอง มีซับใน',
      tags: ['ใหม่'],
    },
    variants: [
      { sku: 'DRESS-FLR-BL-S', color: 'ฟ้า', size: 'S', stock: 2 },
      { sku: 'DRESS-FLR-BL-M', color: 'ฟ้า', size: 'M', stock: 4 },
      { sku: 'DRESS-FLR-YL-M', color: 'เหลือง', size: 'M', stock: 1 },
    ],
  },
  {
    sku: 'DRESS-BLK',
    name: 'เดรสดำทรงเอ',
    category: 'เดรส',
    aliases: ['เดรสดำ', 'little black dress'],
    description:
      'เดรสสีดำทรงเอ ความยาวเหนือเข่า ใส่ทำงาน ออกงาน หรือไปงานแต่งได้',
    basePrice: '1290.00',
    attributes: {
      brand: 'Mira Studio',
      material: 'โพลีเอสเตอร์ผสมสแปนเด็กซ์ ยืดได้เล็กน้อย',
    },
    variants: [
      { sku: 'DRESS-BLK-BK-S', color: 'ดำ', size: 'S', stock: 3 },
      { sku: 'DRESS-BLK-BK-M', color: 'ดำ', size: 'M', stock: 2 },
      { sku: 'DRESS-BLK-BK-L', color: 'ดำ', size: 'L', stock: 0 },
    ],
  },
  {
    sku: 'JEANS-WL',
    name: 'กางเกงยีนส์ขากว้างเอวสูง',
    category: 'กางเกง',
    aliases: ['ยีนส์ขากว้าง'],
    description: 'ยีนส์เอวสูงทรงขากว้าง ช่วยพรางสะโพก ความยาวคลุมข้อเท้า',
    basePrice: '990.00',
    attributes: { brand: 'Denim Lab', material: 'ยีนส์คอตตอน 100% ผ้าไม่ยืด' },
    variants: [
      { sku: 'JEANS-WL-26', color: 'น้ำเงินเข้ม', size: '26', stock: 2 },
      { sku: 'JEANS-WL-28', color: 'น้ำเงินเข้ม', size: '28', stock: 3 },
      { sku: 'JEANS-WL-30', color: 'น้ำเงินเข้ม', size: '30', stock: 0 },
      { sku: 'JEANS-WL-32', color: 'น้ำเงินเข้ม', size: '32', stock: 1 },
    ],
  },
  {
    sku: 'SLACKS',
    name: 'กางเกงสแล็คขาตรง',
    category: 'กางเกง',
    aliases: ['สแล็ค', 'กางเกงสแลค'],
    description: 'กางเกงสแล็คขาตรง เอวยางยืดด้านหลัง ใส่ทำงานได้',
    basePrice: '590.00',
    attributes: { material: 'โพลีเอสเตอร์ ไม่ต้องรีด' },
    variants: [
      { sku: 'SLACKS-BK-S', color: 'ดำ', size: 'S', stock: 4 },
      { sku: 'SLACKS-BK-M', color: 'ดำ', size: 'M', stock: 6 },
      { sku: 'SLACKS-BK-L', color: 'ดำ', size: 'L', stock: 3 },
      { sku: 'SLACKS-BE-M', color: 'เบจ', size: 'M', stock: 2 },
    ],
  },
  {
    sku: 'SKIRT-PLT',
    name: 'กระโปรงพลีทยาว',
    category: 'กระโปรง',
    description: 'กระโปรงพลีทยาวเอวยางยืด',
    basePrice: '650.00',
    trackStock: false,
    attributes: { material: 'ซาตินเนื้อนิ่ม' },
    variants: [
      { sku: 'SKIRT-PLT-CR-F', color: 'ครีม', size: 'Free Size' },
      { sku: 'SKIRT-PLT-BK-F', color: 'ดำ', size: 'Free Size' },
    ],
  },
  {
    sku: 'CARDI-KNT',
    name: 'เสื้อคาร์ดิแกนไหมพรม',
    category: 'เสื้อคลุม',
    aliases: ['คาร์ดิแกน'],
    description: 'คาร์ดิแกนไหมพรม กระดุมหน้า ใส่คลุมกันแอร์',
    basePrice: null,
    attributes: { material: 'ไหมพรมเนื้อนุ่ม' },
    variants: [
      { sku: 'CARDI-KNT-CR-F', color: 'ครีม', size: 'Free Size', stock: 3 },
      { sku: 'CARDI-KNT-BR-F', color: 'น้ำตาล', size: 'Free Size', stock: 2 },
    ],
  },
  {
    sku: 'BAG-TOTE',
    name: 'กระเป๋าผ้าแคนวาส',
    category: 'กระเป๋า',
    description: 'กระเป๋าผ้าใบใหญ่ ใส่โน้ตบุ๊ก 14 นิ้วได้',
    basePrice: '350.00',
    dropStockRow: true,
    attributes: { material: 'ผ้าแคนวาสหนา' },
    variants: [{ sku: 'BAG-TOTE-CR-F', color: 'ครีม', size: 'Free Size' }],
  },
  {
    sku: 'HAT-BKT',
    name: 'หมวกบักเก็ต',
    category: 'หมวก',
    description: 'หมวกบักเก็ตปีกรอบ กันแดด',
    basePrice: '290.00',
    attributes: { material: 'ผ้าคอตตอน' },
    variants: [
      { sku: 'HAT-BKT-BK-F', color: 'ดำ', size: 'Free Size', stock: 5 },
      { sku: 'HAT-BKT-CR-F', color: 'ครีม', size: 'Free Size', stock: 0 },
    ],
  },
  {
    sku: 'LOAFER',
    name: 'รองเท้าโลฟเฟอร์หนัง',
    category: 'รองเท้า',
    description: 'โลฟเฟอร์หนังแท้ พื้นยางกันลื่น ใส่ทำงาน',
    basePrice: '1590.00',
    attributes: { brand: 'Step Mira', material: 'หนังวัวแท้' },
    variants: [
      { sku: 'LOAFER-BK-37', color: 'ดำ', size: '37', stock: 2 },
      { sku: 'LOAFER-BK-38', color: 'ดำ', size: '38', stock: 3 },
      { sku: 'LOAFER-BK-39', color: 'ดำ', size: '39', stock: 0 },
      { sku: 'LOAFER-BK-40', color: 'ดำ', size: '40', stock: 1 },
    ],
  },
  {
    sku: 'SET-LIN',
    name: 'ชุดเซ็ตลินินเสื้อกับกางเกง',
    category: 'ชุดเซ็ต',
    aliases: ['เซ็ตลินิน'],
    description:
      'ชุดเซ็ตลินินเสื้อแขนสั้นกับกางเกงขายาว ใส่สบาย เหมาะกับอากาศร้อน',
    basePrice: '1190.00',
    attributes: { material: 'ลินินผสมคอตตอน' },
    variants: [
      { sku: 'SET-LIN-BE-M', color: 'เบจ', size: 'M', stock: 2 },
      { sku: 'SET-LIN-BE-L', color: 'เบจ', size: 'L', stock: 1 },
      { sku: 'SET-LIN-GN-M', color: 'เขียว', size: 'M', stock: 3 },
    ],
  },
  {
    sku: 'DOWN-JKT',
    name: 'เสื้อกันหนาวขนเป็ด',
    category: 'เสื้อคลุม',
    description: 'เสื้อกันหนาวขนเป็ดแท้ คอลเลกชันหน้าหนาว (ยังไม่เปิดขาย)',
    basePrice: '2490.00',
    status: 'DRAFT',
    attributes: {},
    variants: [{ sku: 'DOWN-JKT-BK-M', color: 'ดำ', size: 'M', stock: 5 }],
  },
];

type SeedKnowledge = Omit<
  CreateAdminAnswerPatternDto,
  'language' | 'priority' | 'active'
>;
export const ANSWER_PATTERNS: SeedKnowledge[] = [
  {
    title: 'ค่าจัดส่ง',
    category: 'การจัดส่ง',
    keywords: ['ค่าส่ง', 'ส่งฟรี', 'ค่าจัดส่ง'],
    questionExamples: ['ค่าส่งเท่าไหร่', 'ส่งฟรีไหม', 'ค่าส่งกี่บาท'],
    answer:
      'ค่าจัดส่งแบบมาตรฐาน 50 บาททั่วประเทศค่ะ ซื้อครบ 1,000 บาทขึ้นไปส่งฟรีค่ะ',
  },
  {
    title: 'ระยะเวลาจัดส่ง',
    category: 'การจัดส่ง',
    keywords: ['จัดส่ง', 'กี่วัน', 'ได้ของ', 'ส่งของ'],
    questionExamples: ['จัดส่งกี่วัน', 'กี่วันได้ของ', 'ส่งของวันไหน'],
    answer:
      'ร้านแพ็กและส่งของภายใน 1-2 วันทำการหลังชำระเงินค่ะ ปกติได้รับภายใน 2-4 วัน (กรุงเทพฯ และปริมณฑล 1-2 วัน)',
  },
  {
    title: 'เก็บเงินปลายทาง',
    category: 'การชำระเงิน',
    keywords: ['ปลายทาง', 'cod', 'เก็บเงินปลายทาง'],
    questionExamples: [
      'เก็บเงินปลายทางได้ไหม',
      'มีเก็บปลายทางไหม',
      'cod ได้ไหม',
    ],
    answer: 'รับเก็บเงินปลายทางค่ะ มีค่าบริการเพิ่ม 30 บาทต่อออเดอร์',
  },
  {
    title: 'ช่องทางชำระเงิน',
    category: 'การชำระเงิน',
    keywords: ['ชำระเงิน', 'โอนเงิน', 'พร้อมเพย์', 'บัตรเครดิต'],
    questionExamples: [
      'ชำระเงินยังไง',
      'จ่ายเงินช่องทางไหนได้บ้าง',
      'โอนเงินยังไง',
    ],
    answer:
      'ชำระได้ทางโอนธนาคาร พร้อมเพย์ หรือบัตรเครดิตผ่านลิงก์ชำระเงินที่แอดมินส่งให้ค่ะ',
  },
  {
    title: 'เปลี่ยนไซส์',
    category: 'เปลี่ยนคืนสินค้า',
    keywords: ['เปลี่ยนไซส์', 'เปลี่ยนสินค้า', 'ใส่ไม่ได้'],
    questionExamples: ['เปลี่ยนไซส์ได้ไหม', 'ใส่ไม่ได้เปลี่ยนได้ไหม'],
    answer:
      'เปลี่ยนไซส์ได้ภายใน 7 วันหลังได้รับสินค้าค่ะ สินค้าต้องยังไม่ผ่านการใส่หรือซัก และป้ายยังอยู่ครบ ลูกค้าออกค่าส่งกลับ ร้านส่งตัวใหม่ให้ฟรีค่ะ',
  },
  {
    title: 'คืนสินค้าและคืนเงิน',
    category: 'เปลี่ยนคืนสินค้า',
    keywords: ['คืนสินค้า', 'คืนเงิน', 'ขอเงินคืน'],
    questionExamples: ['คืนสินค้าได้ไหม', 'ขอคืนเงินได้ไหม'],
    answer:
      'รับคืนและคืนเงินเฉพาะกรณีสินค้าชำรุดหรือส่งผิดแบบค่ะ กรุณาแจ้งภายใน 3 วันหลังได้รับ พร้อมวิดีโอตอนแกะพัสดุ',
  },
  {
    title: 'สีและรูปสินค้า',
    category: 'สินค้า',
    keywords: ['ตรงปก', 'รูปจริง', 'สีเพี้ยน'],
    questionExamples: ['สีตรงปกไหม', 'รูปจริงไหม'],
    answer:
      'รูปสินค้าถ่ายจากของจริงค่ะ สีอาจต่างเล็กน้อยตามแสงและหน้าจอของแต่ละเครื่อง',
  },
  {
    title: 'เวลาตอบแชท',
    category: 'ร้านค้า',
    keywords: ['กี่โมง', 'เวลาทำการ', 'แอดมินตอบ'],
    questionExamples: ['แอดมินตอบกี่โมง', 'ร้านเปิดกี่โมง'],
    answer:
      'แอดมินตอบแชททุกวัน 09:00-21:00 น. ค่ะ นอกเวลาบอทช่วยตอบเบื้องต้นได้ค่ะ',
  },
  {
    title: 'หน้าร้าน',
    category: 'ร้านค้า',
    keywords: ['หน้าร้าน', 'ที่อยู่ร้าน'],
    questionExamples: ['มีหน้าร้านไหม', 'ร้านอยู่ที่ไหน'],
    answer: 'ร้านขายออนไลน์เท่านั้นค่ะ ยังไม่มีหน้าร้าน',
  },
  {
    title: 'โปรโมชั่น',
    category: 'โปรโมชั่น',
    keywords: ['โปร', 'ส่วนลด', 'โค้ด'],
    questionExamples: ['มีโปรอะไรบ้าง', 'มีส่วนลดไหม', 'มีโค้ดไหม'],
    answer:
      'ลูกค้าใหม่ใช้โค้ด MIRA10 ลด 10% สำหรับออเดอร์แรกค่ะ (ใช้ร่วมกับโปรอื่นไม่ได้)',
  },
  {
    title: 'พรีออเดอร์',
    category: 'สินค้า',
    keywords: ['พรีออเดอร์', 'ของเข้า', 'สั่งพรี'],
    questionExamples: ['สินค้าหมดสั่งพรีได้ไหม', 'รอของเข้ากี่วัน'],
    answer:
      'สินค้าที่หมดบางรุ่นสั่งพรีออเดอร์ได้ค่ะ รอประมาณ 7-14 วัน แอดมินจะยืนยันรอบของเข้าให้อีกครั้ง',
  },
];

type SeedMicro = Omit<
  CreateAdminMicroKnowledgeDto,
  'language' | 'priority' | 'active'
>;
export const MICRO_KNOWLEDGE: SeedMicro[] = [
  {
    title: 'ตารางไซส์เสื้อ',
    entityKey: 'size_chart',
    topicKey: 'tops',
    keywords: ['ตารางไซส์', 'ไซส์ไหนดี', 'รอบอก'],
    questionExamples: ['ตารางไซส์เสื้อ', 'อกเท่านี้ใส่ไซส์อะไร'],
    answer:
      'ตารางไซส์เสื้อ (วัดรอบอกเป็นนิ้ว): S อก 32-34, M อก 34-36, L อก 36-38, XL อก 38-40 ถ้าสัดส่วนอยู่ระหว่างสองไซส์แนะนำไซส์ใหญ่กว่า',
  },
  {
    title: 'ตารางไซส์กางเกงและเดรส',
    entityKey: 'size_chart',
    topicKey: 'bottoms',
    keywords: ['ตารางไซส์', 'รอบเอว', 'ไซส์กางเกง'],
    questionExamples: ['ตารางไซส์กางเกง', 'เอวเท่านี้ใส่ไซส์อะไร'],
    answer:
      'ไซส์ยีนส์เป็นรอบเอวนิ้ว เช่น 26 คือเอว 26 นิ้ว ส่วนกางเกงและเดรสไซส์ S/M/L: S เอว 25-27, M เอว 27-29, L เอว 29-31 นิ้ว',
  },
  {
    title: 'การดูแลผ้าลินิน',
    entityKey: 'fabric_care',
    topicKey: 'linen',
    keywords: ['ลินิน', 'ซัก', 'หด'],
    questionExamples: ['ผ้าลินินซักยังไง', 'ลินินหดไหม'],
    answer:
      'ผ้าลินินควรซักมือหรือใส่ถุงซักด้วยน้ำเย็น ไม่ควรอบแห้ง อาจหดได้เล็กน้อยประมาณ 1-2%',
  },
  {
    title: 'การดูแลยีนส์',
    entityKey: 'fabric_care',
    topicKey: 'denim',
    keywords: ['ยีนส์', 'ซัก', 'สีตก'],
    questionExamples: ['ยีนส์ซักยังไง', 'ยีนส์สีตกไหม'],
    answer: 'ยีนส์ควรกลับด้านก่อนซักและซักแยกสีในช่วงแรก เพราะสีอาจตกเล็กน้อย',
  },
  // Two versions of one keyed fact: retrieval must hand off, never pick one.
  {
    title: 'บริการห่อของขวัญ',
    entityKey: 'gift_wrap',
    topicKey: 'fee',
    keywords: ['ห่อของขวัญ', 'ค่าห่อ'],
    questionExamples: ['มีห่อของขวัญไหม'],
    answer: 'บริการห่อของขวัญ ค่าบริการ 20 บาทต่อชิ้น',
  },
  {
    title: 'บริการห่อของขวัญ (ฉบับแก้ไข)',
    entityKey: 'gift_wrap',
    topicKey: 'fee',
    keywords: ['ห่อของขวัญ', 'ค่าห่อ'],
    questionExamples: ['ค่าห่อของขวัญเท่าไหร่'],
    answer: 'บริการห่อของขวัญ ค่าบริการ 35 บาทต่อชิ้น',
  },
  {
    title: 'ส่งด่วนในกรุงเทพฯ',
    entityKey: 'shipping',
    topicKey: 'express',
    keywords: ['ส่งด่วน', 'แมสเซนเจอร์', 'ได้วันนี้'],
    questionExamples: ['ส่งด่วนได้ไหม', 'อยากได้ของวันนี้'],
    answer:
      'ในกรุงเทพฯ ส่งด่วนผ่านแมสเซนเจอร์ได้ ลูกค้าชำระค่าส่งตามระยะทางจริง สั่งก่อน 12:00 น. ได้รับภายในวัน',
  },
];

export type SeededStore = {
  companyId: string;
  adminId: string;
  /** product id -> sku, for readable catalogRefs. */
  codeById: Map<string, string>;
  /** Ground truth for the judge and the number check. */
  facts: string;
  allowedNumbers: Set<string>;
};

const get = <T>(moduleRef: TestingModule, token: Type<T>): T =>
  moduleRef.get(token, { strict: false });

export async function seedFashionStore(
  moduleRef: TestingModule,
  model: { provider: AiProviderName; model: string },
  log: (line: string) => void,
): Promise<SeededStore> {
  const prisma = get(moduleRef, PrismaService);
  const config = get(moduleRef, ConfigService);

  // The real singleton path: CommerceScope requires exactly one company.
  const companyId = await get(moduleRef, CompanyService).getCompanyId();
  await prisma.company.update({
    where: { id: companyId },
    data: { name: `${STORE_NAME} (audit fixture)` },
  });
  const admin = await prisma.adminMember.create({
    data: {
      username: `audit-owner-${randomUUID().slice(0, 8)}`,
      password: 'not-a-login-account',
      firstname: 'Audit',
      lastname: 'Owner',
      email: `audit-${randomUUID()}@example.invalid`,
      phone: `audit-${randomUUID().slice(0, 12)}`,
      role: 'owner',
      companyId,
    },
  });
  const scope = { companyId };

  await get(moduleRef, AiProviderSettingsService).update(
    'USER',
    model.provider,
    model.model,
  );
  await get(moduleRef, AiPricingCatalogService).seedDefaults();

  // Credit the wallet the way production does: a pending slip approved by an owner.
  const topup = await prisma.creditTopupHistory.create({
    data: {
      companyId,
      creditAmount: new Prisma.Decimal('200000'),
      slipImage: 'audit/no-slip',
      requestedById: admin.id,
    },
  });
  const storage = {
    url: () => Promise.resolve(null),
    remove: () => Promise.resolve(),
  } as unknown as FileStorageService;
  await new AdminBillService(
    prisma,
    get(moduleRef, CompanyService),
    storage,
  ).confirmTopup(topup.id, admin.id);

  await prisma.aiSetting.create({
    data: {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      ownerPrompt: OWNER_PROMPT,
      tone: 'สุภาพ เป็นกันเอง',
      responseStyle: { targetLength: 'short', emojiLevel: 'light' },
      fallbackMessage: FALLBACK_MESSAGE,
      active: true,
    },
  });

  await get(moduleRef, ProductAttributeService).applyPreset(
    scope,
    admin.id,
    'FASHION',
    { requestId: randomUUID(), categories: [] },
  );
  const products = get(moduleRef, ProductService);
  const inventory = get(moduleRef, InventoryService);
  const codeById = new Map<string, string>();
  for (const item of CATALOG) {
    const product = await products.create(scope, admin.id, {
      requestId: randomUUID(),
      name: item.name,
      category: item.category,
      aliases: item.aliases ?? [],
      description: item.description,
      status: item.status ?? 'ACTIVE',
      language: 'th',
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
    codeById.set(product.id, item.sku);
    for (const v of item.variants) {
      const variant = product.variants.find((row) => row.sku === v.sku)!;
      if (item.dropStockRow) {
        await prisma.inventoryBalance.delete({
          where: { variantId: variant.id },
        });
        continue;
      }
      if (!v.stock || item.trackStock === false) continue;
      await inventory.adjust(scope, admin.id, product.id, variant.id, {
        requestId: randomUUID(),
        expectedVersion: 1,
        deltaOnHand: v.stock,
        reason: 'ตั้งสต็อกเริ่มต้นของข้อมูลทดสอบ',
      });
    }
  }
  log(`catalog: ${CATALOG.length} products`);

  const embedding = get(moduleRef, EmbeddingService);
  const patterns = new AdminKnowledgePatternService(
    prisma,
    embedding,
    get(moduleRef, AnswerPatternCacheService),
    get(moduleRef, AnswerPatternVectorRepository),
  );
  for (const item of ANSWER_PATTERNS)
    await patterns.create(
      { ...item, language: 'th', priority: 0, active: true },
      admin.id,
    );
  const micro = new AdminKnowledgeMicroService(
    prisma,
    embedding,
    get(moduleRef, MicroKnowledgeVectorRepository),
    config,
  );
  for (const item of MICRO_KNOWLEDGE)
    await micro.create(
      { ...item, language: 'th', priority: 0, active: true },
      admin.id,
    );
  log(
    `knowledge: ${ANSWER_PATTERNS.length} patterns, ${MICRO_KNOWLEDGE.length} facts`,
  );

  // Product vectors come from the real outbox worker (real embeddings).
  const indexer = get(moduleRef, ProductIndexService);
  const active = CATALOG.filter((p) => (p.status ?? 'ACTIVE') === 'ACTIVE');
  const deadline = Date.now() + 180_000;
  for (;;) {
    await indexer.tick();
    const indexed = await prisma.productVector.count({ where: { companyId } });
    if (indexed >= active.length) break;
    if (Date.now() > deadline)
      throw new Error(
        `Product indexing stalled at ${indexed}/${active.length}`,
      );
    await new Promise((done) => setTimeout(done, 1000));
  }
  log(`product vectors: ${active.length}`);

  const { facts, allowedNumbers } = await storeFacts(prisma, companyId);
  return { companyId, adminId: admin.id, codeById, facts, allowedNumbers };
}

const STOCK_TEXT = {
  IN_STOCK: 'มีของ',
  OUT_OF_STOCK: 'หมด',
  NOT_TRACKED: 'ร้านไม่ติดตามสต็อก (ต้องถามแอดมิน)',
  UNKNOWN: 'ไม่มีข้อมูลสต็อก',
} as const;

/** Store truth, read back from the DB rather than from the seed constants. */
async function storeFacts(prisma: PrismaService, companyId: string) {
  const rows = await prisma.product.findMany({
    where: { companyId },
    include: { variants: { include: { inventory: true } } },
    orderBy: { name: 'asc' },
  });
  const patterns = await prisma.answerPattern.findMany({
    orderBy: { title: 'asc' },
  });
  const micro = await prisma.microKnowledge.findMany({
    orderBy: { title: 'asc' },
  });
  const lines: string[] = [
    `ร้าน ${STORE_NAME}: ร้านเสื้อผ้าผู้หญิงออนไลน์ ตอบแชทผ่าน LINE`,
    'ข้อจำกัดของระบบ: บอทยังสั่งซื้อ รับชำระเงิน ตรวจยอดโอน หรือเช็กสถานะพัสดุไม่ได้ เรื่องเหล่านี้ต้องส่งต่อแอดมิน',
    'บอทเห็นสต็อกเป็นสถานะ (มี/หมด) เท่านั้น ไม่เปิดเผยจำนวนชิ้น',
    '',
    '## สินค้า (ราคาเป็นบาท)',
  ];
  const numbers = new Set<string>();
  const addNumbers = (text: string) => {
    for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const value = match[0].replace(/,/g, '');
      numbers.add(value);
      numbers.add(value.replace(/\.0+$/, ''));
    }
  };
  for (const p of rows) {
    const visible = p.status === 'ACTIVE';
    lines.push(
      `- ${p.name} "${p.name}"${visible ? '' : ' [ยังไม่เปิดขาย ห้ามเสนอขาย]'} หมวด ${p.category ?? '-'}; ${p.description}; คุณสมบัติ ${JSON.stringify(p.variants.map((v) => v.meta))}`,
    );
    for (const v of p.variants.filter((x) => x.active)) {
      const price = v.price;
      const stock = !v.trackStock
        ? STOCK_TEXT.NOT_TRACKED
        : !v.inventory
          ? STOCK_TEXT.UNKNOWN
          : v.inventory.onHand > v.inventory.reserved
            ? STOCK_TEXT.IN_STOCK
            : STOCK_TEXT.OUT_OF_STOCK;
      const options = v.meta as Record<string, string>;
      lines.push(
        `  - ${v.sku}: สี ${options.color ?? '-'} ไซส์ ${options.size ?? '-'} ราคา ${price ? price.toFixed(2) : 'ยังไม่ระบุ'} สต็อก ${stock}`,
      );
      if (visible) {
        if (price) addNumbers(price.toFixed(2));
        addNumbers(`${options.size ?? ''}`);
      }
    }
    if (visible)
      addNumbers(
        `${p.description} ${JSON.stringify(p.variants.map((v) => v.meta))}`,
      );
  }
  lines.push('', '## นโยบายร้าน (AnswerPattern)');
  for (const k of patterns) {
    lines.push(`- ${k.title}: ${k.answer}`);
    addNumbers(k.answer);
  }
  lines.push('', '## ข้อเท็จจริงย่อย (MicroKnowledge)');
  for (const k of micro) {
    lines.push(`- ${k.title}: ${k.answer}`);
    addNumbers(k.answer);
  }
  lines.push(
    '',
    'หมายเหตุ: ค่าห่อของขวัญมีสองฉบับที่ขัดกัน (20 และ 35 บาท) บอทต้องไม่เลือกตอบเอง',
    'ร้านไม่มีข้อมูลเรื่องส่งต่างประเทศ ส่วนลดซื้อหลายชิ้น หรือวิธีซักเสื้อยืดครอป',
  );
  return { facts: lines.join('\n'), allowedNumbers: numbers };
}

import type { BusinessPrompt } from '../types/attribute-definition.types';

/** Planner/answer wording for GENERAL stores. Also the fallback for a store without a known business. */
export const GENERAL_PROMPT: BusinessPrompt = {
  planner: `business=GENERAL: ใช้เฉพาะตัวเลือกและ field ที่ประกาศใน storeOptions/storeFields ของร้าน ห้ามสมมติ field ของธุรกิจอื่น`,
  answer: `business=GENERAL: ตอบจาก field ของสินค้าที่มีในหลักฐานเท่านั้น ห้ามเติมคุณสมบัติของธุรกิจอื่น`,
};

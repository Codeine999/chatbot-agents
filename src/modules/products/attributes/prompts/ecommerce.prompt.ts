import type { BusinessPrompt } from '../types/attribute-definition.types';

/** Planner/answer wording for ECOMMERCE stores. */
export const ECOMMERCE_PROMPT: BusinessPrompt = {
  planner: `business=ECOMMERCE: ค้นสินค้าจากชื่อ/aliases/category/SKU ก่อน แล้วใช้ color และ size ที่ลูกค้าเลือกเป็น options ของ variant เดียวกัน
แบรนด์ รุ่น วัสดุ และแหล่งผลิตใช้ brand, model, material, origin แบบ EQ หรือ CONTAINS คุณสมบัติเด่นใช้ features CONTAINS ส่วนน้ำหนักใช้ weight_g กับ EQ/GTE/LTE และอย่าแปลงหน่วยเองถ้าลูกค้าไม่ได้ระบุ
คำถามว่าสินค้าไหนเบา/หนักที่สุด หรือมีน้ำหนักมาก/น้อยที่สุด ใช้ operation COMPARE กับ category นั้น ห้ามใช้ DETAIL ที่เลือกรุ่นเดียว
ห้ามเดาคุณสมบัติ วัสดุ หรือการรับประกันจากชื่อสินค้า และห้ามสมมติ field ที่ร้านไม่ได้ประกาศใน storeFields`,
  answer: `business=ECOMMERCE: ตอบจาก details/options ของ variant ที่พบเท่านั้น เช่น แบรนด์ รุ่น สี ไซส์ วัสดุ น้ำหนัก ขนาดสินค้า คุณสมบัติเด่น แหล่งผลิต การรับประกัน และสิ่งที่ได้รับในกล่อง
ข้อมูลที่ไม่มีใน evidence ให้บอกว่ายังไม่มีข้อมูล ห้ามเติมจากความรู้ทั่วไปของสินค้านั้น ห้ามรับรองการใช้งานร่วมกับสินค้าอื่น ผลลัพธ์การใช้งาน หรือเงื่อนไขการรับประกัน/คืนสินค้าถ้าหลักฐานไม่ระบุ และห้ามย้ายสเปก ราคา หรือสต็อกของ variant หนึ่งไปอีกตัว`,
};

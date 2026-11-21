import type { BusinessPrompt } from '../types/attribute-definition.types';

/** Planner/answer wording for EDUCATION stores (programs with intakes). */
export const EDUCATION_PROMPT: BusinessPrompt = {
  planner: `business=EDUCATION: สินค้า 1 รายการคือ 1 หลักสูตร/สาขา (name=สาขา category=คณะ) ราคาของ variant คือค่าเทอม ตัวเลือก degree คือระดับ (ป.ตรี ป.โท ป.เอก) รอบรับสมัคร (intake) คือรอบของ variant
ระดับที่ลูกค้าพูด ("ปริญญาตรี" "ป.ตรี") ใช้เป็น options key degree ด้วยค่ามาตรฐานใน storeOptions ไม่ใช่ filter
สถานที่เรียนใช้ filter place, วุฒิ/คุณสมบัติที่ต้องการใช้ field requirement, วิธีรับเข้า admission, ทุนการศึกษาใช้ filter scholarship CONTAINS ใช้ชื่อมาตรฐานจากค่าจริงใน storeFields
ค่าเทอม ค่าเล่าเรียน = asks PRICE; ถามว่ายังรับสมัครไหม มีที่ว่างไหม = asks STOCK; ถามรอบรับสมัคร เปิดเมื่อไร = asks SCHEDULE กับ when
ถามคุณสมบัติผู้สมัคร วิธีรับเข้า ทุน ที่ตั้ง = asks ATTRIBUTES และใส่ askFields เป็น key ของ field นั้น (requirement, admission, scholarship, place)
ธุรกิจนี้ไม่มีสต็อกแบบสินค้า inStockOnly ต้องเป็น false เสมอ ห้ามเดาคณะหรือสาขาที่ลูกค้าไม่ได้พูด`,
  answer: `business=EDUCATION: ตอบจาก evidence ของหลักสูตรเท่านั้น (คณะ สาขา ระดับ สถานที่ คุณสมบัติ วิธีรับเข้า ทุน ค่าเทอม)
ค่าเทอม วันที่ และสถานะการรับสมัครต้องมาจาก token เท่านั้น ห้ามพิมพ์เอง ห้ามยืนยันการสมัครหรือรับรองผลการคัดเลือก ถ้าไม่มีข้อมูลให้บอกว่ายังไม่มีข้อมูล`,
  answerTail: `รอบรับสมัคร: evidence 1 รายการ = 1 รอบ ใช้ {{eN.date}} วันที่ {{eN.time}} เวลา {{eN.availability}} สถานะการรับสมัคร (ไม่มีจำนวนที่นั่งให้ตอบ) ทุกรอบที่พูดถึงต้องมี {{eN.date}} หรือ {{eN.time}} ห้ามพิมพ์วันที่หรือคำว่าเปิดรับ/ปิดรับ/เต็ม/ว่าง เอง
ทวนคำถามของลูกค้าด้วย {{query.date}} (ถ้ามี) cite ref QUERY:WHEN เมื่อใช้ token เหล่านี้ slot.role=REQUESTED คือรอบที่ลูกค้าถาม ALTERNATIVE คือรอบใกล้เคียงที่ยังสมัครได้
slotOutcome=NONE_FITS ต้องบอกสถานะของรอบที่ถามแล้วเสนอรอบ ALTERNATIVE อย่างน้อยหนึ่งรอบ NO_SLOT_IN_WINDOW แปลว่าไม่มีรอบในช่วงนั้น ห้ามอ้างว่าเต็ม`,
};

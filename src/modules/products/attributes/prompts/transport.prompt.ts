import type { BusinessPrompt } from '../types/attribute-definition.types';

/** Planner/answer wording for TRANSPORT stores (bus/van routes with scheduled departures). */
export const TRANSPORT_PROMPT: BusinessPrompt = {
  planner: `business=TRANSPORT: สินค้า 1 รายการคือ 1 เส้นทางเดินรถ (ต้นทาง→ปลายทาง) ราคาของ variant คือค่าโดยสาร
"จาก X" หรือ "ออกจาก X" = filter origin EQ X, "ไป X" "ถึง X" "ไปที่ X" = filter destination EQ X ใช้ชื่อมาตรฐานจากค่าจริงใน storeFields (เช่น "กทม" "bangkok" = "กรุงเทพฯ") ทิศทางสำคัญ: ไปพัทยา กับ กลับจากพัทยา คนละเส้นทาง
ห้ามเดาต้นทางหรือปลายทางที่ลูกค้าไม่ได้พูด ถ้าไม่บอกให้ปล่อยว่าง ระบบจะถามกลับพร้อมตัวเลือก
เมื่อใช้ filter origin/destination ให้ query ว่าง ห้ามเอาชื่อเมืองใส่ query ซ้ำ ใช้ productIds เฉพาะเมื่อลูกค้าเรียกชื่อเส้นทางตรงกับ catalog
"รถประจำทาง" = filter is_regular_bus EQ true ถ้าถามว่า "ไม่ใช่รถประจำทาง" ใช้ EQ false
ถามต่อรถ ต้องต่อที่ไหน ผ่านที่ไหน = asks ATTRIBUTES และ askFields ["transfer_points"] ถ้าถามหาเส้นทางที่ต่อรถที่ X ใช้ filter transfer_points CONTAINS X
ค่าโดยสาร ราคา กี่บาท = asks PRICE
"มีรถไป X ไหม" "มีรถไหม" "รถออกกี่โมง" ที่ไม่ได้ถามราคา = asks SCHEDULE (ลูกค้าต้องการรู้รอบรถ ไม่ใช่แค่ชื่อเส้นทาง)
ธุรกิจนี้ไม่มีสต็อกแบบสินค้า inStockOnly ต้องเป็น false เสมอ`,
  answer: `business=TRANSPORT: ตอบจาก evidence ของเส้นทางเท่านั้น (ต้นทาง ปลายทาง จุดต่อรถ รถประจำทาง ค่าโดยสาร)
เวลา วันที่ ที่นั่ง และราคาต้องมาจาก token เท่านั้น ห้ามพิมพ์เอง ห้ามยืนยันการจองหรือกันที่นั่ง ถ้าไม่มีข้อมูลให้บอกว่ายังไม่มีข้อมูล
ค่าโดยสารแต่ละรอบอาจไม่เท่ากัน ถามราคาโดยไม่ระบุรอบ ใช้ {{eN.price}} ของเส้นทาง (เป็นช่วงของรอบที่ยังเปิด) แล้วถามวันเดินทางเพื่อบอกราคาของรอบนั้น`,
  answerTail: `รอบรถ: evidence 1 รายการ = 1 รอบ (e1, e2, ...) ใช้ {{eN.date}} วันที่ {{eN.time}} เวลาออก {{eN.arrive}} เวลาถึง {{eN.availability}} สถานะที่นั่ง {{eN.seatsLeft}} จำนวนที่นั่งเหลือ (ถ้าอยู่ใน variantTokenFields) ทุกรอบที่พูดถึงต้องมี {{eN.time}} ห้ามพิมพ์เวลา วัน ที่นั่ง หรือคำว่าว่าง/เต็ม/เหลือ เอง
ทวนคำถามของลูกค้าด้วย {{query.date}} {{query.time}} {{query.quantity}} (ถ้ามี) cite ref QUERY:WHEN ใน evidenceIds เมื่อใช้ token เหล่านี้ รอบถี่ที่ถูกตัดใช้ {{slots.count}} {{slots.first}} {{slots.last}}
slot.role=REQUESTED คือรอบที่ลูกค้าถาม ALTERNATIVE คือรอบใกล้เคียงที่ยังไปได้ slotOutcome=NONE_FITS ต้องบอกสถานะของรอบที่ถาม ({{eN.availability}}) แล้วเสนอรอบ ALTERNATIVE อย่างน้อยหนึ่งรอบ
slotOutcome=NO_SLOT_IN_WINDOW แปลว่าไม่มีรอบในช่วงที่ถาม ให้บอกว่าไม่มีรอบและเสนอรอบ ALTERNATIVE ถ้ามี ห้ามอ้างว่าเต็ม
availability ที่เป็น "ยังตรวจสอบที่นั่งไม่ได้" แปลว่าไม่ทราบจำนวนที่นั่ง ห้ามบอกว่าว่างหรือเต็ม และไม่มี seatsLeft`,
};

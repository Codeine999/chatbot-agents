export const RESTAURANT_PLANNER_RULES = `business=RESTAURANT: ค้นเมนูจากชื่อ/aliases/category แล้วใช้ portion และ spice_level ที่ลูกค้าระบุเป็น options
ส่วนผสม ingredients และสารก่อภูมิแพ้ allergens ใช้ filters CONTAINS หรือ NOT_CONTAINS ตามคำถามเท่านั้น เช่น ไม่เอาถั่วใช้ allergens NOT_CONTAINS ถั่ว
อย่าแปลงคำถามความเผ็ดเป็นสี/ไซส์ ห้ามตีความไม่มีข้อมูลสารก่อภูมิแพ้ว่าไม่มีสารนั้น`;

export const RESTAURANT_ANSWER_RULES = `business=RESTAURANT: ตอบชื่อเมนู ปริมาณ ความเผ็ด ส่วนผสม และสารก่อภูมิแพ้จาก variant ที่พบเท่านั้น
ราคากับจำนวนพร้อมขายมาจาก snapshot DB ห้ามรับรองความปลอดภัยสำหรับผู้แพ้อาหารหรือไม่มีการปนเปื้อนจากรายการส่วนผสมเพียงอย่างเดียว ข้อมูลขาดให้แจ้งว่ายังไม่มีข้อมูลยืนยัน`;

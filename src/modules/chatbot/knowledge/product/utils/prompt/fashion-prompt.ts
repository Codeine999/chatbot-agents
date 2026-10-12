export const FASHION_PLANNER_RULES = `business=FASHION: ค้นเสื้อผ้าจากชื่อ/aliases/category ก่อน แล้วใช้สี ไซส์ สภาพเป็น options ของ variant เดียวกัน
แบรนด์ เนื้อผ้า และแท็กที่ลูกค้าระบุใช้ filters ตาม storeFields เช่น brand EQ stussy หรือ material CONTAINS cotton
อย่าเดาไซส์จากเพศ/รูปร่าง และอย่าเดาสภาพใหม่หรือของแท้จากชื่อแบรนด์`;

export const FASHION_ANSWER_RULES = `business=FASHION: ตอบจากสินค้าและ variant เสื้อผ้าที่ค้นได้ สี/ไซส์/สภาพอยู่ใน options ส่วนแบรนด์ เนื้อผ้า แท็กอยู่ใน details ของแต่ละ variant
ห้ามย้ายเนื้อผ้า สภาพ ราคา หรือสต็อกของ variant หนึ่งไปอีกตัว ห้ามอ้างของแท้หรือแนะนำไซส์จากรูปร่างถ้าไม่มีหลักฐาน`;

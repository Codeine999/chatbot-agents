/**
 * Offline retrieval eval cases (Thai). Lexical (BM25 / exact) is the real
 * matcher over the seeded KB in src/scripts (computer shop AnswerPatterns +
 * clinic MicroKnowledge). Vector similarity is MOCKED per case: no embedding
 * provider is called. The mock bands follow the calibration recorded in
 * knowledge-routing.constants.ts (small talk 0.56–0.71, KB questions median
 * ~0.80), so results show how the decision logic reacts to those bands, not
 * how good the embedding model is. Re-measure with decisionLogs before trusting
 * any threshold.
 *
 * Reference format: 'AP:<title prefix>' | 'MK:<title prefix>'.
 */
export type EvalGroup = 'ANSWERABLE' | 'GENERAL' | 'OUT_OF_KB';

export type EvalCase = Readonly<{
  id: string;
  group: EvalGroup;
  query: string;
  /** ANSWERABLE: any of these must reach the LLM context. */
  gold?: readonly string[];
  /** ANSWERABLE multi-topic: every one of these must reach the context. */
  goldAll?: readonly string[];
  /** Mocked cosine similarity of each vector candidate. */
  vec: readonly (readonly [string, number])[];
  /** Documented gap the current logic cannot close; asserted as still failing. */
  knownGap?: string;
}>;

const HOURS_C = 'MK:วันและเวลาเปิดกุยลิ้มฮึ้ง คลินิก';
const HOURS_P = 'MK:วันและเวลาเปิดร้านยา';
const ADMIN = 'AP:ติดต่อแอดมิน';

export const EVAL_CASES: readonly EvalCase[] = [
  // ---- ANSWERABLE: exact question text ----
  {
    id: 'a-exact-pharmacy',
    group: 'ANSWERABLE',
    query: 'ร้านยาเปิดวันเสาร์ไหม',
    gold: [HOURS_P],
    vec: [[HOURS_P, 0.88]],
  },
  {
    id: 'a-exact-shipping',
    group: 'ANSWERABLE',
    query: 'ค่าส่งเท่าไหร่',
    gold: ['AP:ค่าจัดส่งสินค้า'],
    vec: [['AP:ค่าจัดส่งสินค้า', 0.86]],
  },

  // ---- ANSWERABLE: paraphrase, strong vector ----
  {
    id: 'a-para-delivery-time',
    group: 'ANSWERABLE',
    query: 'สั่งของแล้วจะได้รับเมื่อไหร่ครับ',
    gold: ['AP:ค่าจัดส่งสินค้า', 'AP:เช็คสถานะออเดอร์'],
    vec: [
      ['AP:ค่าจัดส่งสินค้า', 0.77],
      ['AP:เช็คสถานะออเดอร์', 0.75],
    ],
  },
  {
    id: 'a-para-parking',
    group: 'ANSWERABLE',
    query: 'ถ้าขับรถมามีที่ให้จอดไหม',
    gold: [
      'MK:ที่จอดรถสถานีกรุงเทพ',
      'MK:ที่จอดรถโชว์รูมฮอนด้า',
      'MK:ที่จอดรถสวนกวางตุ้ง',
    ],
    vec: [
      ['MK:ที่จอดรถสถานีกรุงเทพ', 0.8],
      ['MK:ที่จอดรถโชว์รูมฮอนด้า', 0.79],
      ['MK:ที่จอดรถสวนกวางตุ้ง', 0.78],
    ],
  },
  {
    id: 'a-para-sleep',
    group: 'ANSWERABLE',
    query: 'อยากได้ตัวช่วยให้หลับสบาย',
    gold: ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับการนอนหลับ'],
    vec: [
      ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับการนอนหลับ', 0.79],
      ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับความเครียด', 0.7],
    ],
  },
  {
    id: 'a-para-clinic-hours',
    group: 'ANSWERABLE',
    query: 'หมอตรวจถึงกี่โมงคะ',
    gold: [HOURS_C],
    vec: [
      [HOURS_C, 0.76],
      [HOURS_P, 0.74],
    ],
  },
  {
    id: 'a-para-doctor',
    group: 'ANSWERABLE',
    query: 'หมออากงยังตรวจคนไข้อยู่ไหม',
    gold: ['MK:หมออากงตรวจคนไข้ที่คลินิก'],
    vec: [
      ['MK:หมออากงตรวจคนไข้ที่คลินิก', 0.82],
      ['MK:หมออากงคือใคร', 0.78],
    ],
  },
  {
    id: 'a-para-no-boot',
    group: 'ANSWERABLE',
    query: 'เครื่องไม่ยอมติดเลย ทำไงดี',
    gold: ['AP:เปิดเครื่องไม่ติด'],
    vec: [
      ['AP:เปิดเครื่องไม่ติด', 0.8],
      ['AP:เปิดเครื่องแล้วจอไม่ขึ้นภาพ', 0.72],
    ],
  },
  {
    id: 'a-para-os',
    group: 'ANSWERABLE',
    query: 'เครื่องใหม่ยังไม่มีระบบปฏิบัติการ ต้องทำยังไง',
    gold: ['AP:ติดตั้ง Windows ใหม่'],
    vec: [['AP:ติดตั้ง Windows ใหม่', 0.75]],
  },
  {
    id: 'a-para-invoice',
    group: 'ANSWERABLE',
    query: 'ต้องการบิลออกชื่อบริษัท',
    gold: ['AP:ขอใบกำกับภาษี'],
    vec: [['AP:ขอใบกำกับภาษี', 0.8]],
  },
  {
    id: 'a-para-warranty',
    group: 'ANSWERABLE',
    query: 'ของพังภายในปีแรกเคลมได้ไหม',
    gold: ['AP:นโยบายการรับประกันสินค้า', 'AP:ขั้นตอนเคลมสินค้า'],
    vec: [
      ['AP:นโยบายการรับประกันสินค้า', 0.74],
      ['AP:ขั้นตอนเคลมสินค้า', 0.73],
    ],
  },
  {
    id: 'a-para-needle',
    group: 'ANSWERABLE',
    query: 'ฝังเข็มเจ็บไหมคะ',
    gold: ['MK:เข็มที่ใช้ฝังเข็ม', 'MK:การฝังเข็ม'],
    vec: [
      ['MK:เข็มที่ใช้ฝังเข็ม', 0.74],
      ['MK:การฝังเข็ม', 0.72],
    ],
  },

  // ---- ANSWERABLE: lexical decoy ranks first, the right item is vector-led ----
  {
    id: 'a-decoy-noise',
    group: 'ANSWERABLE',
    query: 'เปิดคอมแล้วมีเสียงดังผิดปกติ',
    gold: ['AP:เครื่องร้อนหรือพัดลมเสียงดัง'],
    vec: [
      ['AP:เครื่องร้อนหรือพัดลมเสียงดัง', 0.78],
      ['AP:เปิดเครื่องไม่ติด', 0.69],
    ],
  },
  {
    id: 'a-decoy-restart',
    group: 'ANSWERABLE',
    query: 'เล่นเกมอยู่ดีๆ เครื่องก็ดับแล้วเปิดใหม่เอง',
    gold: ['AP:คอมค้าง รีสตาร์ทเอง'],
    vec: [
      ['AP:คอมค้าง รีสตาร์ทเอง', 0.77],
      ['AP:การ์ดจอไม่ถูกตรวจพบหรือเล่นเกมไม่ลื่น', 0.71],
    ],
  },
  {
    id: 'a-decoy-sunday',
    group: 'ANSWERABLE',
    query: 'วันอาทิตย์ไปหาหมอได้หรือเปล่า',
    gold: ['MK:บริการคลินิกวันอาทิตย์'],
    vec: [
      ['MK:บริการคลินิกวันอาทิตย์', 0.8],
      [HOURS_P, 0.7],
    ],
  },
  {
    id: 'a-decoy-contact',
    group: 'ANSWERABLE',
    query: 'จะนัดหมอต้องโทรเบอร์ไหน',
    gold: ['MK:เบอร์โทรกุยลิ้มฮึ้ง คลินิก'],
    vec: [
      ['MK:เบอร์โทรกุยลิ้มฮึ้ง คลินิก', 0.79],
      ['MK:เบอร์โทรร้านยา', 0.74],
    ],
  },

  {
    id: 'a-decoy-claim',
    group: 'ANSWERABLE',
    query: 'ส่งการ์ดจอไปเคลมต้องทำยังไง',
    gold: ['AP:ขั้นตอนเคลมสินค้า'],
    vec: [
      ['AP:ขั้นตอนเคลมสินค้า', 0.8],
      ['AP:การแพ็คสินค้าป้องกันความเสียหาย', 0.66],
    ],
  },
  {
    id: 'a-vector-only-anchor',
    group: 'ANSWERABLE',
    query: 'ลูกค้าเก่าแก่กี่ปีแล้วคะ ร้านนี้',
    gold: ['MK:ปีที่ก่อตั้งร้านกุยลิ้มฮึ้ง'],
    vec: [
      ['MK:ปีที่ก่อตั้งร้านกุยลิ้มฮึ้ง', 0.81],
      ['MK:รุ่นที่ดูแลกิจการปัจจุบัน', 0.72],
    ],
  },

  // ---- ANSWERABLE: only the keyword channel finds it (embedding down or below the floor) ----
  {
    id: 'a-lexical-only-invoice',
    group: 'ANSWERABLE',
    query: 'ใบกำกับภาษี',
    gold: ['AP:ขอใบกำกับภาษี'],
    vec: [],
  },
  {
    id: 'a-lexical-only-build-fee',
    group: 'ANSWERABLE',
    query: 'ค่าประกอบคอมเท่าไหร่',
    gold: ['AP:บริการประกอบคอม'],
    vec: [],
  },
  {
    id: 'a-lexical-only-build-time',
    group: 'ANSWERABLE',
    query: 'สั่งประกอบคอมแล้วต้องรอกี่วัน',
    gold: ['AP:ระยะเวลาประกอบคอม'],
    vec: [],
  },
  {
    id: 'a-lexical-only-stock',
    group: 'ANSWERABLE',
    query: 'การ์ดจอ RTX รุ่นนี้มีของไหม',
    gold: ['AP:สอบถามราคาและสต็อกสินค้า'],
    vec: [],
  },
  {
    id: 'a-lexical-only-migraine',
    group: 'ANSWERABLE',
    query: 'ปวดหัวไมเกรนกินอะไรดี',
    gold: ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับอาการปวดหัว'],
    vec: [],
  },

  // ---- ANSWERABLE: multi-topic in one message ----
  {
    id: 'a-multi-ship-pack',
    group: 'ANSWERABLE',
    query: 'ส่งกี่วันถึง แล้วแพ็คกันกระแทกไหม',
    goldAll: ['AP:ค่าจัดส่งสินค้า', 'AP:การแพ็คสินค้าป้องกันความเสียหาย'],
    vec: [
      ['AP:ค่าจัดส่งสินค้า', 0.78],
      ['AP:การแพ็คสินค้าป้องกันความเสียหาย', 0.77],
    ],
  },
  {
    id: 'a-multi-clinic',
    group: 'ANSWERABLE',
    query: 'คลินิกอยู่ตรงไหน แล้วเปิดกี่โมง',
    goldAll: ['MK:ที่อยู่กุยลิ้มฮึ้ง', HOURS_C],
    vec: [
      ['MK:ที่อยู่กุยลิ้มฮึ้ง', 0.76],
      [HOURS_C, 0.77],
    ],
  },

  // ---- ANSWERABLE: loose paraphrase, weaker vector (0.66–0.72) ----
  {
    id: 'a-weak-address',
    group: 'ANSWERABLE',
    query: 'ไปซื้อสมุนไพรต้องไปที่ไหน',
    gold: ['MK:ที่อยู่กุยลิ้มฮึ้ง', 'MK:สอบถามราคาสินค้า'],
    vec: [
      ['MK:ที่อยู่กุยลิ้มฮึ้ง', 0.69],
      ['MK:สอบถามราคาสินค้า', 0.67],
    ],
  },
  {
    id: 'a-weak-bulk-price',
    group: 'ANSWERABLE',
    query: 'สั่งหลายชิ้นต้องจ่ายค่าขนส่งเพิ่มไหม',
    gold: ['AP:ค่าจัดส่งสินค้า'],
    vec: [['AP:ค่าจัดส่งสินค้า', 0.68]],
  },
  {
    id: 'a-weak-contact-doc',
    group: 'ANSWERABLE',
    query: 'อยากคุยกับหมอก่อนไปต้องติดต่อทางไหน',
    gold: ['MK:เบอร์โทรกุยลิ้มฮึ้ง คลินิก'],
    vec: [
      ['MK:เบอร์โทรกุยลิ้มฮึ้ง คลินิก', 0.7],
      [ADMIN, 0.66],
    ],
  },
  {
    id: 'a-weak-low',
    group: 'ANSWERABLE',
    query: 'ปวดเมื่อยตามตัวไปทำอะไรได้บ้าง',
    gold: ['MK:ทุยนา', 'MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับปวดเมื่อย'],
    vec: [
      ['MK:ทุยนา', 0.64],
      ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับปวดเมื่อย', 0.63],
    ],
  },

  // ---- GENERAL: small talk, similarity sits in the noise band ----
  {
    id: 'g-joke',
    group: 'GENERAL',
    query: 'เล่าเรื่องตลกให้ฟังหน่อย',
    vec: [
      [ADMIN, 0.58],
      ['MK:หมออากงตรวจคนไข้ที่คลินิก', 0.57],
    ],
    knownGap:
      'หลักฐานชิ้นแรกมาจากคำทั่วไปที่บังเอิญตรงฟิลด์ที่ admin เขียน (เช่น "เรื่อง") และชิ้นแรกถูกยกเว้นจากด่าน coverage โดยตั้งใจ (ไม่งั้นคำถามที่ตรงโดเมนจะเสียหลักฐาน) ต้องให้ classifier เห็นหลักฐาน (ขั้น 4)',
  },
  {
    id: 'g-football',
    group: 'GENERAL',
    query: 'เมื่อคืนฟุตบอลสนุกไหม',
    vec: [['MK:ปีที่ก่อตั้งร้านกุยลิ้มฮึ้ง', 0.58]],
    knownGap:
      'หลักฐานชิ้นแรกมาจากคำทั่วไปที่บังเอิญตรงฟิลด์ที่ admin เขียน (เช่น "เรื่อง") และชิ้นแรกถูกยกเว้นจากด่าน coverage โดยตั้งใจ (ไม่งั้นคำถามที่ตรงโดเมนจะเสียหลักฐาน) ต้องให้ classifier เห็นหลักฐาน (ขั้น 4)',
  },
  {
    id: 'g-movie',
    group: 'GENERAL',
    query: 'แนะนำหนังสนุกๆ หน่อย',
    vec: [['MK:ทุยนา', 0.59]],
    knownGap:
      'หลักฐานชิ้นแรกมาจากคำทั่วไปที่บังเอิญตรงฟิลด์ที่ admin เขียน (เช่น "เรื่อง") และชิ้นแรกถูกยกเว้นจากด่าน coverage โดยตั้งใจ (ไม่งั้นคำถามที่ตรงโดเมนจะเสียหลักฐาน) ต้องให้ classifier เห็นหลักฐาน (ขั้น 4)',
  },
  {
    id: 'g-math',
    group: 'GENERAL',
    query: 'หนึ่งบวกหนึ่งได้เท่าไหร่',
    vec: [['AP:เลือกขนาด PSU', 0.6]],
    knownGap:
      'candidate เดียวมาจาก vector 0.60 ติดพื้นพอดี การตัดต้องใช้พื้น vector ที่สูงขึ้นหรือ classifier เห็นหลักฐาน (ขั้น 4)',
  },
  {
    id: 'g-how-are-you',
    group: 'GENERAL',
    query: 'วันนี้เป็นยังไงบ้าง',
    vec: [
      ['MK:จุดเริ่มต้นของร้านกุยลิ้มฮึ้ง', 0.62],
      [ADMIN, 0.63],
    ],
    knownGap:
      'ข้อความเหลือคำเนื้อหาคำเดียวคือ "วัน" ซึ่งตรง FAQ เวลาเปิดทาง BM25 (coverage 100% เพราะไม่มีคำอื่นให้เทียบ)',
  },
  {
    id: 'g-thanks',
    group: 'GENERAL',
    query: 'ขอบคุณมากเลยนะคะ',
    vec: [
      ['MK:ปีที่ก่อตั้งร้านกุยลิ้มฮึ้ง', 0.61],
      [ADMIN, 0.64],
    ],
    knownGap:
      'vector-only 0.64 ต่ำกว่า gate แต่เหนือพื้น 0.60 จึงยังเป็นหลักฐาน',
  },
  {
    id: 'g-still-there',
    group: 'GENERAL',
    query: 'ยังอยู่ไหมคะ',
    vec: [
      [HOURS_C, 0.66],
      [HOURS_P, 0.65],
    ],
    knownGap:
      'cosine 0.65–0.66 คาบเกี่ยวกับ paraphrase จริง ต้องให้ classifier เห็นหลักฐาน (ขั้น 4)',
  },
  {
    id: 'g-name',
    group: 'GENERAL',
    query: 'คุณชื่ออะไรคะ',
    vec: [
      [ADMIN, 0.66],
      ['MK:หมออากงคือใคร', 0.64],
    ],
    knownGap: 'คำว่า "ชื่อ" ตรงกับหลักฐานของหมออากงทาง BM25',
  },
  {
    id: 'g-tired',
    group: 'GENERAL',
    query: 'วันนี้เหนื่อยจังเลย',
    vec: [
      ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับความเครียด', 0.67],
      ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับบำรุงกำลัง', 0.66],
    ],
    knownGap: 'ใกล้สินค้าบำรุงจริง cosine 0.66–0.67 ไม่มี threshold ที่แยกได้',
  },
  {
    id: 'g-hot-weather',
    group: 'GENERAL',
    query: 'วันนี้อากาศร้อนมากเลย',
    vec: [
      ['MK:สินค้าที่ระบุสรรพคุณเกี่ยวกับร้อนใน', 0.69],
      ['AP:เครื่องร้อนหรือพัดลมเสียงดัง', 0.63],
    ],
    knownGap: 'คำว่า "ร้อน" ตรงสินค้าร้อนในทั้ง BM25 และ vector',
  },

  // ---- OUT_OF_KB: sounds like the business, KB has no such fact ----
  {
    id: 'o-branch',
    group: 'OUT_OF_KB',
    query: 'มีสาขาที่เชียงใหม่ไหมคะ',
    vec: [
      ['MK:ที่อยู่กุยลิ้มฮึ้ง', 0.71],
      ['MK:หน่วยบริการของกุยลิ้มฮึ้ง', 0.68],
    ],
    knownGap:
      'ถึงพื้น 0.71 จึงยังเป็นหลักฐานให้ LLM; ต้องให้ classifier/grounded บอกว่าไม่ตรง (ขั้น 4)',
  },
  {
    id: 'o-promo',
    group: 'OUT_OF_KB',
    query: 'ตอนนี้มีโปรโมชั่นลดราคาไหม',
    vec: [
      ['MK:สอบถามราคาสินค้า', 0.69],
      ['AP:สอบถามราคาและสต็อกสินค้า', 0.67],
    ],
    knownGap: 'หลักฐานเรื่องราคาใกล้เคียง 0.67–0.69',
  },
  {
    id: 'o-abroad',
    group: 'OUT_OF_KB',
    query: 'ส่งไปต่างประเทศได้ไหม',
    vec: [['AP:ค่าจัดส่งสินค้า', 0.72]],
    knownGap: 'ใกล้เรื่องค่าส่ง 0.72 และมีคำว่า "ส่ง" ตรงทาง BM25',
  },
  {
    id: 'o-buyback',
    group: 'OUT_OF_KB',
    query: 'รับซื้อสมุนไพรจากชาวสวนไหม',
    vec: [['MK:การขยายสู่การขายส่งและนำเข้าสมุนไพร', 0.7]],
    knownGap: 'เรื่องขายส่งสมุนไพรใกล้เคียง 0.70',
  },
];

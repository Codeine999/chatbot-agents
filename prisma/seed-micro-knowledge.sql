-- Seed 10 independently composable business facts derived from existing
-- AnswerPattern rows. The JOIN prevents a fact from being inserted when its
-- source pattern is missing and carries the source tenant scope forward.
--
-- This script only writes source content. After committing it, call
-- POST /api/admin/knowledge-micro/reindex to create/update embeddings.

WITH seed (
  "id",
  "sourceAnswerPatternId",
  "title",
  "category",
  "intentKey",
  "entityKey",
  "topicKey",
  "keywords",
  "questionExamples",
  "answer",
  "language",
  "priority",
  "active"
) AS (
  VALUES
    (
      '91000000-0000-4000-8000-000000000001'::uuid,
      '32f239d2-6417-54d4-a9bc-0a2f95f7d550'::uuid,
      'ขนาดห้อง Deluxe King',
      'ROOM_FACT',
      'DELUXE_KING_SIZE',
      'room:deluxe-king',
      'room-size',
      ARRAY['Deluxe King', 'ห้องดีลักซ์', 'ขนาดห้อง', '36 ตร.ม.']::text[],
      ARRAY['ห้อง Deluxe King ขนาดเท่าไร', 'ห้องดีลักซ์กี่ตารางเมตร']::text[],
      'ห้อง Deluxe King มีขนาด 36 ตารางเมตร',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000002'::uuid,
      '32f239d2-6417-54d4-a9bc-0a2f95f7d550'::uuid,
      'ราคาต่อคืนของ Deluxe King',
      'ROOM_RATE',
      'DELUXE_KING_NIGHTLY_RATE',
      'room:deluxe-king',
      'nightly-rate',
      ARRAY['Deluxe King', 'ห้องดีลักซ์', 'ราคาต่อคืน', '2,300 บาท']::text[],
      ARRAY['Deluxe King คืนละเท่าไร', 'ห้องดีลักซ์หนึ่งคืนราคาเท่าไร']::text[],
      'ห้อง Deluxe King ราคา 2,300 บาทต่อห้องต่อคืน ไม่รวมอาหารเช้า',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000003'::uuid,
      '32f239d2-6417-54d4-a9bc-0a2f95f7d550'::uuid,
      'ราคา 7 คืนของ Deluxe King',
      'ROOM_RATE',
      'DELUXE_KING_WEEKLY_RATE',
      'room:deluxe-king',
      'weekly-rate',
      ARRAY['Deluxe King', 'ห้องดีลักซ์', '7 คืน', '13,800 บาท']::text[],
      ARRAY['Deluxe King พัก 7 คืนเท่าไร', 'ห้องดีลักซ์พักหนึ่งสัปดาห์ราคาเท่าไร']::text[],
      'ห้อง Deluxe King ราคา 13,800 บาทต่อห้องสำหรับการพักต่อเนื่อง 7 คืน ไม่รวมอาหารเช้า',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000004'::uuid,
      '32f239d2-6417-54d4-a9bc-0a2f95f7d550'::uuid,
      'เตียงเสริมของ Deluxe King',
      'ROOM_POLICY',
      'DELUXE_KING_EXTRA_BED',
      'room:deluxe-king',
      'extra-bed',
      ARRAY['Deluxe King', 'เตียงเสริม', '600 บาท', 'ผู้ใหญ่ 3 คน']::text[],
      ARRAY['Deluxe King เพิ่มเตียงได้ไหม', 'เตียงเสริมห้องดีลักซ์ราคาเท่าไร']::text[],
      'ห้อง Deluxe King เพิ่มเตียงเสริมได้ 1 เตียง ราคา 600 บาทต่อคืน และรองรับผู้ใหญ่รวมสูงสุด 3 คน',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000005'::uuid,
      'b5975024-cbbe-52da-8c2f-57fe0bdc56e5'::uuid,
      'จำนวนผู้เข้าพักสูงสุดของ Family Suite',
      'ROOM_POLICY',
      'FAMILY_SUITE_CAPACITY',
      'room:family-suite',
      'max-occupancy',
      ARRAY['Family Suite', 'ห้องครอบครัว', 'ผู้ใหญ่ 4 คน', 'จำนวนผู้เข้าพัก']::text[],
      ARRAY['Family Suite พักได้กี่คน', 'มีห้องสำหรับผู้ใหญ่สี่คนไหม']::text[],
      'ห้อง Family Suite รองรับผู้ใหญ่สูงสุด 4 คน',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000006'::uuid,
      'e224ab0b-9ab3-5a85-a1a8-09c05d61862a'::uuid,
      'เงื่อนไขยืนยันการจอง',
      'BOOKING_POLICY',
      'BOOKING_CONFIRMATION',
      'booking:direct',
      'confirmation',
      ARRAY['ยืนยันการจอง', 'ตรวจสอบมัดจำ', 'เลขยืนยันการจอง']::text[],
      ARRAY['จองสำเร็จเมื่อไร', 'รู้ได้อย่างไรว่ายืนยันการจองแล้ว']::text[],
      'การจองจะยืนยันเมื่อโรงแรมตรวจสอบมัดจำและออกเลขยืนยันการจองแล้ว',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000007'::uuid,
      'e224ab0b-9ab3-5a85-a1a8-09c05d61862a'::uuid,
      'การเปลี่ยนวันสำหรับการจองตรง',
      'BOOKING_POLICY',
      'DIRECT_BOOKING_DATE_CHANGE',
      'booking:direct',
      'date-change',
      ARRAY['เปลี่ยนวันเข้าพัก', 'เลื่อนวัน', 'จองตรง', 'ล่วงหน้า 72 ชั่วโมง']::text[],
      ARRAY['จองตรงเลื่อนวันได้ไหม', 'ต้องแจ้งเปลี่ยนวันล่วงหน้ากี่ชั่วโมง']::text[],
      'การจองตรงแบบมาตรฐานเปลี่ยนวันได้ 1 ครั้ง เมื่อแจ้งล่วงหน้าอย่างน้อย 72 ชั่วโมงก่อนเวลาเช็คอิน 14:00 น. โดยขึ้นกับห้องว่างและส่วนต่างราคา',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000008'::uuid,
      'e224ab0b-9ab3-5a85-a1a8-09c05d61862a'::uuid,
      'การออกก่อนกำหนด',
      'BOOKING_POLICY',
      'EARLY_DEPARTURE_REFUND',
      'booking:direct',
      'early-departure',
      ARRAY['ออกก่อนกำหนด', 'เช็คเอาต์ก่อน', 'คืนเงิน', 'คืนที่เหลือ']::text[],
      ARRAY['ออกก่อนกำหนดได้เงินคืนไหม', 'เช็คเอาต์ก่อนวันจองคืนเงินหรือไม่']::text[],
      'หากออกก่อนกำหนด โรงแรมไม่คืนเงินสำหรับคืนที่เหลือ',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000009'::uuid,
      '69aafe75-f25e-5fb2-bd4c-645e289dfe5c'::uuid,
      'เวลาให้บริการรูมเซอร์วิส',
      'HOTEL_SERVICE',
      'ROOM_SERVICE_HOURS',
      'service:room-service',
      'opening-hours',
      ARRAY['รูมเซอร์วิส', 'สั่งอาหาร', 'บริการถึงห้อง', '11:00', '21:00']::text[],
      ARRAY['รูมเซอร์วิสเปิดกี่โมง', 'สั่งรูมเซอร์วิสได้ถึงกี่โมง']::text[],
      'รูมเซอร์วิสเปิดให้บริการทุกวันเวลา 11:00–21:00 น.',
      'th', 50, true
    ),
    (
      '91000000-0000-4000-8000-000000000010'::uuid,
      '46e5fa01-e92f-567b-9fde-0a42bc86fcfe'::uuid,
      'นโยบายห้ามสูบบุหรี่ในห้องพัก',
      'STAY_POLICY',
      'NON_SMOKING_ROOM',
      'policy:smoking',
      'room-smoking',
      ARRAY['ห้ามสูบบุหรี่', 'บุหรี่ไฟฟ้า', 'ค่าทำความสะอาด', '3,000 บาท']::text[],
      ARRAY['สูบบุหรี่ในห้องได้ไหม', 'สูบบุหรี่ในห้องเสียค่าปรับเท่าไร']::text[],
      'ห้องพักปลอดบุหรี่และบุหรี่ไฟฟ้า หากฝ่าฝืนมีค่าทำความสะอาด 3,000 บาท',
      'th', 50, true
    )
),
resolved AS (
  SELECT
    seed."id",
    source."tenantId",
    seed."title",
    seed."category",
    seed."intentKey",
    seed."entityKey",
    seed."topicKey",
    seed."keywords",
    seed."questionExamples",
    seed."answer",
    seed."language",
    seed."priority",
    seed."active"
  FROM seed
  INNER JOIN "answerPattern" AS source
    ON source."id" = seed."sourceAnswerPatternId"
   AND source."active" = true
)
INSERT INTO "microKnowledge" (
  "id",
  "tenantId",
  "title",
  "category",
  "intentKey",
  "entityKey",
  "topicKey",
  "keywords",
  "questionExamples",
  "answer",
  "language",
  "priority",
  "active"
)
SELECT
  "id",
  "tenantId",
  "title",
  "category",
  "intentKey",
  "entityKey",
  "topicKey",
  "keywords",
  "questionExamples",
  "answer",
  "language",
  "priority",
  "active"
FROM resolved
ON CONFLICT ("id") DO UPDATE SET
  "tenantId" = EXCLUDED."tenantId",
  "title" = EXCLUDED."title",
  "category" = EXCLUDED."category",
  "intentKey" = EXCLUDED."intentKey",
  "entityKey" = EXCLUDED."entityKey",
  "topicKey" = EXCLUDED."topicKey",
  "keywords" = EXCLUDED."keywords",
  "questionExamples" = EXCLUDED."questionExamples",
  "answer" = EXCLUDED."answer",
  "language" = EXCLUDED."language",
  "priority" = EXCLUDED."priority",
  "active" = EXCLUDED."active",
  "updatedAt" = CURRENT_TIMESTAMP;

-- These source patterns contain several independent facts. They remain useful
-- as broad evidence, but must not short-circuit the unified retrieval pipeline
-- before the matching MicroKnowledge facts are read.
UPDATE "answerPattern"
SET
  "renderMode" = 'rewrite',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (
  '32f239d2-6417-54d4-a9bc-0a2f95f7d550'::uuid,
  'b5975024-cbbe-52da-8c2f-57fe0bdc56e5'::uuid,
  'e224ab0b-9ab3-5a85-a1a8-09c05d61862a'::uuid,
  '69aafe75-f25e-5fb2-bd4c-645e289dfe5c'::uuid,
  '46e5fa01-e92f-567b-9fde-0a42bc86fcfe'::uuid
)
  AND "active" = true
  AND "renderMode" = 'direct';

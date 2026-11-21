# Report: test case รอบรถ — input → RAG serve → คำตอบสุดท้ายของ LLM

รัน 20 พ.ย. 2026 · App channel จริง · 71 จาก 80 เคส · chat LLM 98/100 · embedding 12

**วิธีอ่าน**
- *Flow* = flow ที่ระบบเข้าจริง (PRODUCT / KNOWLEDGE / GENERAL / FALLBACK) เทียบกับที่คาดไว้
- *RAG serve* = route, matchType, answerMode, fallbackReason จาก decisionLogs + commerceTurns
- *AnswerPattern / MicroKnowledge* = candidate จาก knowledge retrieval (✓ = ถูกเลือกส่งให้ LLM)
- *Product evidence* = slot/variant ที่ product search ส่งให้ LLM (เวลาเป็น Asia/Bangkok)
- *ตรวจสอบ* = ผลของ verifier เทียบกับ DB จริง

## 1. ตารางสรุปทุกเคส

| ID | กลุ่ม | คำถาม | คาดไว้ | ได้จริง | answerMode | AP/MK ที่เลือก | Product evidence | LLM call | ตรวจสอบ |
|---|---|---|---|---|---|---|---|---|---|
| P01 | product | พัทยาไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P02 | product | กรุงเทพ พัทยา | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P03 | product | กรุงเทพ เชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 2 | 2 | PARTIAL |
| P04 | product | กทม-เชียงใหม่ VIP ราคาเท่าไหร่ | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 2 | 2 | PARTIAL |
| P05 | product | พรุ่งนี้เช้าไประยองมีกี่โมง | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 2 | 2 | PARTIAL |
| P09 | product | เชียงใหม่ไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 2 | 2 | PARTIAL |
| P11 | product | วันอาทิตย์นี้พัทยาไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 4 | 1 | PASS |
| P12 | product | กรุงเทพไปเชียงใหม่คืนนี้ รอบไหนบ้าง | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| P17 | product | พัทยาไปกรุงเทพพรุ่งนี้ 10 โมง | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 3 | 1 | PASS |
| P20 | product | กรุงเทพไประยองพรุ่งนี้ 9 โมง ที่นั่งว่างไหม | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| P23 | product | พัทยากรุงเทพวันอาทิตย์ 4 โมงเย็นเหลือกี่ที่นั่ง | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| P29 | product | กรุงเทพไปน่านมีรถไหม | PRODUCT | PRODUCT | PRODUCT_NO_MATCH | AP 0 / MK 0 | 0 | 1 | PARTIAL |
| P14 | product | กรุงเทพไปเกาะช้างต้องต่อรถไหม | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| D01 | decoy | จองตั๋วที่ไหน | KNOWLEDGE | KNOWLEDGE | GROUNDED | AP 3 / MK 0 | 0 | 2 | PASS |
| D02 | decoy | ขึ้นรถที่ไหน | KNOWLEDGE | KNOWLEDGE | DIRECT_PRESET | AP 1 / MK 0 | 0 | 0 | PASS |
| D04 | decoy | ยกเลิกตั๋วคืนเงินได้ไหม | FALLBACK | FALLBACK | FALLBACK | AP 3 / MK 0 | 0 | 2 | PASS |
| D08 | decoy | สวัสดีครับ | GENERAL | GENERAL | GENERAL | AP 0 / MK 0 | 0 | 1 | PASS |
| D12 | decoy | ขับรถเองไปพัทยากี่ชั่วโมง | GENERAL | PRODUCT | FALLBACK | AP 0 / MK 0 | 1 | 2 | FAIL |
| D13 | decoy | ไปเที่ยวเชียงใหม่ช่วงไหนดี | GENERAL | PRODUCT | FALLBACK | AP 0 / MK 0 | 2 | 2 | FAIL |
| FA1 | followup | สอบถามรอบรถค่ะ | PRODUCT | PRODUCT | PRODUCT_MISSING_INPUT | AP 0 / MK 0 | 0 | 1 | PASS |
| FA2 | followup | กรุงเทพไปเชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 11 | 1 | PASS |
| FA3 | followup | มีรอบกี่โมงบ้าง | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 11 | 1 | PASS |
| FA4 | followup | รอบ 4 ทุ่มราคาเท่าไหร่ | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 3 | 2 | PASS |
| FC1 | followup | กรุงเทพไประยองพรุ่งนี้ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 3 | 1 | PARTIAL |
| FC2 | followup | ขึ้นรถที่ไหน | KNOWLEDGE | KNOWLEDGE | DIRECT_PRESET | AP 1 / MK 0 | 0 | 0 | PASS |
| FC3 | followup | แล้วรอบถัดไปล่ะ | PRODUCT | PRODUCT | PRODUCT_UNMATCHED_SUGGESTIONS | AP 0 / MK 0 | 1 | 2 | FAIL |
| P10 | product | วันเสาร์นี้ กรุงเทพไปหัวหินกี่โมงบ้าง | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 3 | 1 | PARTIAL |
| P06 | product | รอบสุดท้ายคืนนี้ไปหัวหิน | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 3 | 1 | PASS |
| P13 | product | รถไปขอนแก่นคืนนี้มีไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PASS |
| P15 | product | ไปเกาะช้างพรุ่งนี้มีรอบไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PASS |
| P16 | product | ไปเกาะช้างวันจันทร์ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PARTIAL |
| P18 | product | เชียงใหม่ไปกรุงเทพวันเสาร์ 3 ทุ่ม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PASS |
| P19 | product | กรุงเทพไปเชียงใหม่ VIP วันจันทร์ | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| P21 | product | กรุงเทพไปเชียงใหม่พรุ่งนี้ 4 ทุ่มที่ว่างไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 4 | 1 | PASS |
| P22 | product | VIP กรุงเทพเชียงใหม่คืนนี้เหลือกี่ที่ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PASS |
| P24 | product | กรุงเทพ พัทยา วันที่ 28 พ.ย. ราคา | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 5 | 1 | PASS |
| P26 | product | กรุงเทพไประยองราคาเท่าไหร่ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P27 | product | พัทยาไปกรุงเทพราคาเท่าไร | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P28 | product | กรุงเทพไปขอนแก่นราคา | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P30 | product | กรุงเทพไปภูเก็ต | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| P33 | product | ไปเกาะช้างเป็นรถประจำทางไหม | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P34 | product | กรุงเทพไประยองเป็นรถประจำทางหรือเปล่า | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P08 | product | กรุงเทพไประยองพรุ่งนี้ 06:30 ไป 3 คนพอไหม | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| P47 | product | 5 ธ.ค. กรุงเทพไปพัทยามีกี่รอบ | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| P50 | product | ตอนนี้มีรถไปพัทยาไหม | PRODUCT | PRODUCT | FALLBACK | AP 0 / MK 0 | 0 | 1 | FAIL |
| FB1 | followup | พัทยาไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| FB2 | followup | พรุ่งนี้ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 4 | 1 | PASS |
| FB3 | followup | บ่ายๆ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PASS |
| FD1 | followup | กรุงเทพไปหัวหินพรุ่งนี้ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 3 | 1 | PARTIAL |
| FD2 | followup | เปลี่ยนเป็นไประยองแทน | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 3 | 1 | PARTIAL |
| D03 | decoy | ชำระเงินยังไง | KNOWLEDGE | KNOWLEDGE | DIRECT_PRESET | AP 1 / MK 0 | 0 | 0 | PASS |
| D05 | decoy | เอาสัตว์เลี้ยงขึ้นรถได้ไหม | FALLBACK | FALLBACK | FALLBACK | AP 3 / MK 0 | 0 | 2 | PASS |
| D06 | decoy | สัมภาระเอาขึ้นรถได้กี่กิโล | KNOWLEDGE | KNOWLEDGE | GROUNDED | AP 3 / MK 0 | 0 | 2 | PASS |
| D07 | decoy | ติดต่อแอดมิน | FALLBACK | FALLBACK | TEMPLATE | AP 0 / MK 0 | 0 | 0 | PASS |
| D09 | decoy | ขอบคุณค่ะ | GENERAL | GENERAL | GENERAL | AP 0 / MK 0 | 0 | 2 | PASS |
| D10 | decoy | วันนี้อากาศเป็นไง | GENERAL | GENERAL | GENERAL | AP 0 / MK 0 | 0 | 2 | PASS |
| D11 | decoy | แนะนำร้านอาหารพัทยาหน่อย | GENERAL | PRODUCT | PRODUCT_UNMATCHED_SUGGESTIONS | AP 0 / MK 0 | 2 | 2 | FAIL |
| D14 | decoy | บริษัทตั้งอยู่ที่ไหน | KNOWLEDGE | KNOWLEDGE | GROUNDED | AP 2 / MK 1 | 0 | 2 | PASS |
| D15 | decoy | ทำไมรถเมื่อวานมาช้า | FALLBACK | FALLBACK | FALLBACK | AP 2 / MK 1 | 0 | 2 | PASS |
| P35 | product | พัทยาาาาไปกทม | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P36 | product | บางกอกไปเชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 2 | 2 | PARTIAL |
| P37 | product | bkk to cnx tonight | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 3 | 1 | PASS |
| P38 | product | Bangkok to Pattaya tomorrow morning | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 2 | 1 | PASS |
| P39 | product | Pattaya to Bangkok price | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P40 | product | ขอรอบรถค่ะ | PRODUCT | PRODUCT | PRODUCT_MISSING_INPUT | AP 0 / MK 0 | 0 | 1 | PASS |
| P41 | product | รอบรถ | PRODUCT | PRODUCT | PRODUCT_MISSING_INPUT | AP 0 / MK 0 | 0 | 1 | PASS |
| P42 | product | เชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 2 | 2 | PARTIAL |
| P43 | product | ระยอง | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | AP 0 / MK 0 | 1 | 2 | PASS |
| P44 | product | ตีหนึ่งมีรถไหม | PRODUCT | PRODUCT | PRODUCT_MISSING_INPUT | AP 0 / MK 0 | 0 | 1 | PASS |
| P45 | product | สิ้นเดือนไปเชียงใหม่มีรถไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PARTIAL |
| P46 | product | 25 ธ.ค. กรุงเทพไปพัทยา | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | AP 0 / MK 0 | 1 | 1 | PASS |

## 2. รายละเอียดราย case

### P01 · product · conv `s-P01` turn 1

**Input:** พัทยาไปกรุงเทพ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13361 in / 804 out · 6864 ms · commerceTurn `eac38c48-7566-4d0e-9bf8-5c88ca522b6c`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00–350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> พัทยา → กรุงเทพฯ มีราคาโดยสารอยู่ที่ 316.00–350.00 บาท (ราคาขึ้นกับรอบ) ค่ะ ราคาจะขึ้นกับรอบเดินทาง หากบอกวันที่ที่ต้องการเดินทาง ทางเราจะแจ้งราคาของรอบนั้นให้ค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Route พัทยา→กรุงเทพฯ correct direction; price range 316-350 equals min/max of OPEN slot prices; asks for date.

---

### P02 · product · conv `s-P02` turn 1

**Input:** กรุงเทพ พัทยา

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13387 in / 1375 out · 9839 ms · commerceTurn `e5f6826a-8bae-45c9-bbec-82c00171c1ff`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ได้เลยค่ะ เส้นทาง กรุงเทพฯ → พัทยา
> รถตู้/รถประจำทางจากกรุงเทพฯ (เอกมัย) ไปพัทยา ใช้เวลาประมาณ 2.5 ชั่วโมง
> ต้นทาง: กรุงเทพฯ
> ปลายทาง: พัทยา
> รถประจำทาง: มี
> 
> หากต้องการทราบวันและเวลาเดินทาง แจ้งวันที่ที่สะดวกได้เลยนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Direction กรุงเทพฯ→พัทยา correct; only route profile (no price/rounds) but user gave no date; description matches DB (2.5 ชม.).

---

### P03 · product · conv `s-P03` turn 1

**Input:** กรุงเทพ เชียงใหม่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13546 in / 1673 out · 12886 ms · commerceTurn `c47075df-dd07-4510-ac36-a491f52c1a48`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | - | - | - | - |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00–1090.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> กรุงเทพฯ → เชียงใหม่ มีราคาดังนี้ค่ะ
> 
> ตัวเลือก BKK-CNX-STD ราคา 650.00 บาท
> ตัวเลือก BKK-CNX-VIP ราคา 990.00–1090.00 บาท (ราคาขึ้นกับรอบ)
> 
> ราคาของตัวเลือกที่สองขึ้นกับรอบเดินทาง หากบอกวันที่ต้องการเดินทาง ยินดีเช็กราคาของรอบนั้นให้ค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Prices correct (650 / 990-1090) but reply prints raw SKU "BKK-CNX-STD/VIP" as option names.
- distortions: [{"type": "RAW_SKU_LEAK", "severity": "medium", "detail": "LLM template used {{eN.sku}}; internal SKU codes shown to customer instead of class label (Standard/VIP)", "code": "rag/product-answer.policy.ts:142,473"}]

---

### P04 · product · conv `s-P04` turn 1

**Input:** กทม-เชียงใหม่ VIP ราคาเท่าไหร่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13404 in / 1586 out · 28953 ms · commerceTurn `63a7a048-4181-4368-a3bd-98c7b12585d1`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | - | - | - | - |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00–1090.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> กรุงเทพฯ → เชียงใหม่ · ราคา 650.00 บาท
> กรุงเทพฯ → เชียงใหม่ · ราคา 990.00–1090.00 บาท (ราคาขึ้นกับรอบ)

**ตรวจสอบกับ DB:** evidenceInDb `True` · User asked VIP price; reply lists 650 and 990-1090 in two unlabeled lines (same name). Correct VIP number is present but customer cannot tell which is VIP. LLM template ("ประเภท VIP ... {{e2.price}}") was rejected by renderer because prose contained "ตายตัว" (certainWords) even though negated.
- distortions: [{"type": "UNLABELED_VARIANTS", "severity": "medium", "detail": "Safe template has no variant/class label; Standard price shown to a VIP question", "code": "rag/product-answer.policy.ts:698-706,945-956; attributes/presets/transport.lexicon.ts:35"}]

---

### P05 · product · conv `s-P05` turn 1

**Input:** พรุ่งนี้เช้าไประยองมีกี่โมง

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13547 in / 630 out · 5177 ms · commerceTurn `d2b7155d-cc4a-4c16-b068-75232fc17a44`
- plan: mode `PRODUCT` · operation `LIST` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": "05:00", "before": "11:00"}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 06:30 | AVAILABLE | 11 | REQUESTED |
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 09:00 | FULL | 0 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - ระยอง (เสาร์ 21 พ.ย.)
> • กรุงเทพฯ 06:30, 09:00
> ราคาต่อคน 280 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · 06:30 and 09:00 correct for Sat 21 morning, price 280 correct; 09:00 is FULL (13/13) but not flagged.
- distortions: [{"type": "FULL_ROUND_NOT_FLAGGED", "severity": "medium", "detail": "BKK-RYG-STD Sat 21 09:00 is FULL (capacity=reserved) per DB slot a170b57c; compact timetable lists it as a normal departure with no \"เต็ม\" mark", "code": "slots/slot-answer.ts:111-120,173-215"}]

---

### P09 · product · conv `s-P09` turn 1

**Input:** เชียงใหม่ไปกรุงเทพ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13622 in / 1575 out · 12475 ms · commerceTurn `4e264cfd-3063-4268-8636-8dd21b0f1c9c`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `2` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| เชียงใหม่ → กรุงเทพฯ | CNX-BKK-STD | 650.00 | - | - | - | - |
| เชียงใหม่ → กรุงเทพฯ | CNX-BKK-VIP | 990.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> เชียงใหม่ → กรุงเทพฯ มีราคาโดยสารดังนี้ค่ะ
> 
> รหัส CNX-BKK-STD ราคา 650.00 บาท
> รหัส CNX-BKK-VIP ราคา 990.00 บาท
> 
> ราคาอาจต่างกันตามรอบเดินทาง หากแจ้งวันที่ที่ต้องการเดินทาง จะช่วยเช็กราคาของรอบนั้นให้ค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Direction เชียงใหม่→กรุงเทพฯ and prices correct but reply prints "รหัส CNX-BKK-STD / CNX-BKK-VIP" (raw SKU).
- distortions: [{"type": "RAW_SKU_LEAK", "severity": "medium", "detail": "LLM template used {{eN.sku}}; internal SKU codes shown to customer instead of class label (Standard/VIP)", "code": "rag/product-answer.policy.ts:142,473"}]

---

### P11 · product · conv `s-P11` turn 1

**Input:** วันอาทิตย์นี้พัทยาไปกรุงเทพ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7687 in / 577 out · 3892 ms · commerceTurn `009e1e4c-21fe-43dd-8a46-51c63518a8c8`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-22", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | อา. 22/11 09:00 | AVAILABLE | 32 | REQUESTED |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | อา. 22/11 13:00 | AVAILABLE | 25 | REQUESTED |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | อา. 22/11 16:00 | LOW | 2 | REQUESTED |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 350.00 | อา. 22/11 19:00 | AVAILABLE | 18 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – พัทยา - กรุงเทพฯ (อาทิตย์ 22 พ.ย.)
> • พัทยา 09:00, 13:00, 16:00, 19:00
> ราคาต่อคนประมาณ 316–350 บาท ราคาอาจต่างกันในแต่ละรอบ
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sun 22 PTY->BKK 09:00,13:00,16:00,19:00 match DB; price range 316-350 matches slot prices (16:00 has 2 seats left, not asked).

---

### P12 · product · conv `s-P12` turn 1

**Input:** กรุงเทพไปเชียงใหม่คืนนี้ รอบไหนบ้าง

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7754 in / 900 out · 10686 ms · commerceTurn `7dfb30d7-c31e-4d2c-9647-560e3be6dfac`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN truncated -> fallback+handoff. DB has BKK-CNX Fri 20 20:30 STD(26), 21:00 VIP(2), 22:00 STD(20).
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: BKK-CNX 20:30 STD, 21:00 VIP (2 left), 22:00 STD", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### P17 · product · conv `s-P17` turn 1

**Input:** พัทยาไปกรุงเทพพรุ่งนี้ 10 โมง

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7690 in / 277 out · 2585 ms · commerceTurn `00ff38e8-5d4c-416d-8ca8-2083744f2344`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE', 'SCHEDULE'] · when `{"date": "2026-11-21", "after": "09:30", "before": "10:30"}` · search status `FOUND` · slotOutcome `NO_SLOT_IN_WINDOW` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `NO_SLOT_IN_WINDOW`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | ส. 21/11 07:00 | AVAILABLE | 35 | ALTERNATIVE |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | ส. 21/11 14:00 | AVAILABLE | 28 | ALTERNATIVE |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 350.00 | ส. 21/11 17:30 | AVAILABLE | 20 | ALTERNATIVE |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ไม่พบรอบ เสาร์ 21 พ.ย. 10:00 น. ของ พัทยา → กรุงเทพฯ ค่ะ
> 
> รอบใกล้เคียงที่ยังไปได้:
> • เสาร์ 21 พ.ย. 07:00 น. · ถึงประมาณ 09:30 น. · 316.00 บาท
> • เสาร์ 21 พ.ย. 14:00 น. · ถึงประมาณ 16:30 น. · 316.00 บาท
> • เสาร์ 21 พ.ย. 17:30 น. · ถึงประมาณ 20:00 น. · 350.00 บาท

**ตรวจสอบกับ DB:** evidenceInDb `True` · 10:00 round is CANCELLED in DB; reply says not found and offers 07:00,14:00,17:30 (all OPEN, prices 316/316/350, arrival times match).

---

### P20 · product · conv `s-P20` turn 1

**Input:** กรุงเทพไประยองพรุ่งนี้ 9 โมง ที่นั่งว่างไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7693 in / 900 out · 6214 ms · commerceTurn `0c233c1e-dada-467f-aa56-ea02e70ed312`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN truncated. DB: RYG Sat 21 09:00 is FULL; should say full and offer 06:30/13:00.
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: RYG Sat 21 09:00 FULL, 06:30 left 11, 13:00 left 7", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### P23 · product · conv `s-P23` turn 1

**Input:** พัทยากรุงเทพวันอาทิตย์ 4 โมงเย็นเหลือกี่ที่นั่ง

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7543 in / 900 out · 7142 ms · commerceTurn `6cb5e0dd-9af1-4747-9f5f-1d382401e8b6`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN truncated. DB: PTY->BKK Sun 22 16:00 left 2 (38/40).
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: PTY-BKK Sun 22 16:00 left 2", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### P29 · product · conv `s-P29` turn 1

**Input:** กรุงเทพไปน่านมีรถไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_NO_MATCH` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7516 in / 699 out · 4580 ms · commerceTurn `90c90617-3066-4321-b752-f3ab60c8c5fe`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ยังไม่พบเส้นทางที่ตรงกับคำถาม ระบุต้นทางและปลายทางเพิ่มเติมได้ค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · No Nan route; reply says route not found but asks user to give origin and destination although both were given; never says Nan is unavailable. No invented data.
- distortions: [{"type": "MISLEADING_CLARIFY", "severity": "low", "detail": "asks for origin/destination already provided", "code": "attributes/presets/transport.lexicon.ts clarify.notFound"}]

---

### P14 · product · conv `s-P14` turn 1

**Input:** กรุงเทพไปเกาะช้างต้องต่อรถไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13420 in / 1263 out · 10130 ms · commerceTurn `25153e3e-6d83-446c-8134-954696b09d40`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['ATTRIBUTES'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เกาะช้าง | BKK-KCH-TRN | 750.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขอบคุณที่สอบถามนะคะ ตามข้อมูลของ กรุงเทพฯ → เกาะช้าง มีจุดต่อรถ ได้แก่ ตราด, ท่าเรือเลมงอบ ค่ะ หากต้องการรายละเอียดเพิ่มเติมเกี่ยวกับรอบรถหรือเวลาเดินทาง แจ้งวันที่ที่สนใจได้เลยนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Transfer points ตราด, ท่าเรือเลมงอบ = variant meta transfer_points; correct.

---

### D01 · decoy · conv `s-D01` turn 1

**Input:** จองตั๋วที่ไหน

**Flow:** คาด `KNOWLEDGE` → ได้ `KNOWLEDGE` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `EMBEDDING` · reason: knowledge retrieval selected RAG
- answerType `KNOWLEDGE` · answerMode `GROUNDED` · action `ANSWER_KNOWLEDGE` · matchType `HYBRID`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13018 in / 480 out · 6825 ms · commerceTurn `None`
- plan: mode `KNOWLEDGE` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | ช่องทางติดต่อ BKS (บขส.) | ✓ | 0.696 | 4.945 | KEYWORD,EMBEDDING |
| 2 | ANSWER_PATTERN | ช่องทางจองตั๋ว BKS E-Ticket | ✓ | 0.781 | 3.339 | KEYWORD,EMBEDDING |
| 3 | ANSWER_PATTERN | [TEST] จุดขึ้นรถ | ✓ | 0.729 | 3.771 | KEYWORD,EMBEDDING |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> จองตั๋วโดยสารออนไลน์ได้ที่
> • แอป BKS E-Ticket (รองรับ iOS และ Android)
> • เว็บไซต์ Transport.co.th หรือระบบ BKS E-Ticket Web
> 
> จองล่วงหน้า เลือกที่นั่งตามต้องการ และชำระเงินผ่านช่องทางต่าง ๆ ได้
> สอบถามการจองทางโทรศัพท์ได้ที่สายด่วนจองตั๋ว 02-936-3660

**ตรวจสอบกับ DB:** evidenceInDb `True` · FAQ booking channels equal AP b7cbb023 text; no product data. (Opened commerceTurn + 1 PLAN call by design.)

---

### D02 · decoy · conv `s-D02` turn 1

**Input:** ขึ้นรถที่ไหน

**Flow:** คาด `KNOWLEDGE` → ได้ `KNOWLEDGE` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `DIRECT` · routeSource `CACHE` · reason: knowledge retrieval selected DIRECT
- answerType `KNOWLEDGE` · answerMode `DIRECT_PRESET` · action `ANSWER_KNOWLEDGE` · matchType `None`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 0 call · 0 in / 0 out · 181 ms · commerceTurn `None`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | [TEST] จุดขึ้นรถ | ✓ | - | 6.903 | EXACT |
| 2 | ANSWER_PATTERN | [TEST] สัมภาระ |  | - | 3.722 | KEYWORD |
| 3 | ANSWER_PATTERN | ช่องทางติดต่อ BKS (บขส.) |  | - | 2.293 | KEYWORD |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขึ้นรถได้ที่ท่ารถตามที่ระบุบนตั๋ว เช่น สถานีหมอชิต 2 หรือสถานีเอกมัย กรุณามาถึงก่อนเวลารถออกอย่างน้อย 30 นาทีค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Equals AP 391f3b0a.

---

### D04 · decoy · conv `s-D04` turn 1

**Input:** ยกเลิกตั๋วคืนเงินได้ไหม

**Flow:** คาด `FALLBACK` → ได้ `FALLBACK` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `LOW_CONFIDENCE` · routeSource `AI` · reason: product planner classified KNOWLEDGE
- answerType `KNOWLEDGE` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `HYBRID`
- isFallback `True` · fallbackReason `INSUFFICIENT_CONTEXT` · handoff `True`
- LLM 2 call · 12646 in / 470 out · 6311 ms · commerceTurn `None`
- plan: mode `KNOWLEDGE` · operation `DETAIL` · asks ['POLICY'] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | ช่องทางจองตั๋ว BKS E-Ticket | ✓ | 0.651 | 4.417 | KEYWORD,EMBEDDING |
| 2 | ANSWER_PATTERN | [TEST] ช่องทางชำระเงิน | ✓ | 0.626 | 3.558 | KEYWORD,EMBEDDING |
| 3 | ANSWER_PATTERN | ช่องทางติดต่อ BKS (บขส.) | ✓ | 0.615 | 1.530 | KEYWORD,EMBEDDING |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · No refund/cancel KB in answerPattern/microKnowledge -> fallback+handoff correct. 2 LLM calls wasted.

---

### D08 · decoy · conv `s-D08` turn 1

**Input:** สวัสดีครับ

**Flow:** คาด `GENERAL` → ได้ `GENERAL` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `None` · routeSource `RULE` · reason: just GREET -> GENERAL_QUESTION
- answerType `GENERAL` · answerMode `GENERAL` · action `GENERAL_QUESTION` · matchType `None`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 2057 in / 136 out · 2212 ms · commerceTurn `None`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> สวัสดีครับ ยินดีต้อนรับสู่บริการของ บขส ครับ 😊
> 
> มีอะไรให้ช่วยเกี่ยวกับการเดินทางด้วยรถโดยสารไหมครับ เช่น รอบรถ เวลาออก ค่าโดยสาร เส้นทาง หรือสถานีขึ้นลงรถ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Greeting.

---

### D12 · decoy · conv `s-D12` turn 1

**Input:** ขับรถเองไปพัทยากี่ชั่วโมง

**Flow:** คาด `GENERAL` → ได้ `PRODUCT` ❌ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `True` · fallbackReason `PRODUCT_INSUFFICIENT_CONTEXT` · handoff `True`
- LLM 2 call · 13409 in / 1295 out · 9998 ms · commerceTurn `4eeb304e-57b9-4c8f-94ca-c8627c5e8ed6`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Planner said GENERAL, clamped to PRODUCT, LLM answer INSUFFICIENT_CONTEXT -> generic fallback+handoff for a general question (LLM had produced a polite refusal).
- distortions: [{"type": "UNNECESSARY_HANDOFF_DECOY", "severity": "medium", "detail": "bare alias \"พัทยา\" on BKK-PTY made probe non-empty; clamp forced PRODUCT", "code": "rag/product-retrieval.service.ts:379-381,602-640"}]

---

### D13 · decoy · conv `s-D13` turn 1

**Input:** ไปเที่ยวเชียงใหม่ช่วงไหนดี

**Flow:** คาด `GENERAL` → ได้ `PRODUCT` ❌ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `True` · fallbackReason `PRODUCT_INSUFFICIENT_CONTEXT` · handoff `True`
- LLM 2 call · 13785 in / 1405 out · 9612 ms · commerceTurn `d2a09070-f1c1-43b7-a0cc-3ba7ac10a87a`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | - | - | - | - |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00–1090.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Same as D12 (alias "เชียงใหม่" on BKK-CNX).
- distortions: [{"type": "UNNECESSARY_HANDOFF_DECOY", "severity": "medium", "detail": "planner GENERAL clamped to PRODUCT", "code": "rag/product-retrieval.service.ts:379-381"}]

---

### FA1 · followup · conv `conv-A` turn 1

**Input:** สอบถามรอบรถค่ะ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_MISSING_INPUT` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7346 in / 471 out · 3371 ms · commerceTurn `09e885e4-b4cd-4cf1-8ced-f57514eda260`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `null` · search status `MISSING_INPUT` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ต้องการเดินทางเส้นทางไหนคะ: กรุงเทพฯ → เกาะช้าง / พัทยา → กรุงเทพฯ / เชียงใหม่ → กรุงเทพฯ / กรุงเทพฯ → พัทยา / กรุงเทพฯ → หัวหิน

**ตรวจสอบกับ DB:** evidenceInDb `True` · Clarifies route (lists 5 of 8).

---

### FA2 · followup · conv `conv-A` turn 2

**Input:** กรุงเทพไปเชียงใหม่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 8357 in / 754 out · 7027 ms · commerceTurn `b62f7b90-a601-4e46-b555-e7cf0cd5c7dd`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `null` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 20:30 | AVAILABLE | 26 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | ศ. 20/11 21:00 | LOW | 2 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 22:00 | AVAILABLE | 20 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 21/11 20:30 | AVAILABLE | 15 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | ส. 21/11 21:00 | AVAILABLE | 18 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 21/11 22:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | อา. 22/11 20:30 | AVAILABLE | 31 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | อา. 22/11 21:00 | AVAILABLE | 14 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | พ. 25/11 22:00 | AVAILABLE | 40 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 28/11 20:30 | AVAILABLE | 38 | REQUESTED |

_(+1 แถว)_

**คำตอบสุดท้ายของ LLM / ระบบ**

> รอบรถ กรุงเทพฯ → เชียงใหม่
> • ศุกร์ 20 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • ศุกร์ 20 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท
> • ศุกร์ 20 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 21 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 21 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท
> • เสาร์ 21 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท · ที่นั่งเต็ม
> • อาทิตย์ 22 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • อาทิตย์ 22 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท
> • พุธ 25 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 28 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 28 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 1090.00 บาท

**ตรวจสอบกับ DB:** evidenceInDb `True` · All 11 OPEN BKK->CNX rounds in DB (cancelled Mon 23 VIP excluded), times/arrival/prices correct, Sat 21 22:00 FULL flagged. Long list but asked all rounds; STD/VIP distinguishable only by price.

---

### FA3 · followup · conv `conv-A` turn 3

**Input:** มีรอบกี่โมงบ้าง

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 9645 in / 244 out · 3043 ms · commerceTurn `88510f34-5577-4ee4-9ef4-4e2507f9b003`
- plan: mode `PRODUCT` · operation `LIST` · asks ['SCHEDULE'] · when `null` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `2` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 20:30 | AVAILABLE | 26 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | ศ. 20/11 21:00 | LOW | 2 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 22:00 | AVAILABLE | 20 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 21/11 20:30 | AVAILABLE | 15 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | ส. 21/11 21:00 | AVAILABLE | 18 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 21/11 22:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | อา. 22/11 20:30 | AVAILABLE | 31 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | อา. 22/11 21:00 | AVAILABLE | 14 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | พ. 25/11 22:00 | AVAILABLE | 40 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 28/11 20:30 | AVAILABLE | 38 | REQUESTED |

_(+1 แถว)_

**คำตอบสุดท้ายของ LLM / ระบบ**

> รอบรถ กรุงเทพฯ → เชียงใหม่
> • ศุกร์ 20 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • ศุกร์ 20 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท
> • ศุกร์ 20 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 21 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 21 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท
> • เสาร์ 21 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท · ที่นั่งเต็ม
> • อาทิตย์ 22 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • อาทิตย์ 22 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท
> • พุธ 25 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 28 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 28 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 1090.00 บาท

**ตรวจสอบกับ DB:** evidenceInDb `True` · Context kept; same 11 rounds correct.

---

### FA4 · followup · conv `conv-A` turn 4

**Input:** รอบ 4 ทุ่มราคาเท่าไหร่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 18459 in / 1365 out · 8570 ms · commerceTurn `eac9e409-da1e-4ceb-804c-f80a5c87c77e`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE', 'SCHEDULE'] · when `{"date": null, "after": "21:30", "before": "22:30"}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 22:00 | AVAILABLE | 20 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 21/11 22:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | พ. 25/11 22:00 | AVAILABLE | 40 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> รอบรถ กรุงเทพฯ → เชียงใหม่
> • ศุกร์ 20 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท
> • เสาร์ 21 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท · ที่นั่งเต็ม
> • พุธ 25 พ.ย. 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท

**ตรวจสอบกับ DB:** evidenceInDb `True` · 22:00 rounds Fri 20, Sat 21 (FULL flagged), Wed 25; 650 correct. Wasted ANSWER LLM call (askFields origin/destination) then safe template.

---

### FC1 · followup · conv `conv-C` turn 1

**Input:** กรุงเทพไประยองพรุ่งนี้

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7673 in / 766 out · 6233 ms · commerceTurn `8e7b51a1-452e-4025-836f-0399a7249778`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 06:30 | AVAILABLE | 11 | REQUESTED |
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 09:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 13:00 | AVAILABLE | 7 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - ระยอง (เสาร์ 21 พ.ย.)
> • กรุงเทพฯ 06:30, 09:00, 13:00
> ราคาต่อคน 280 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 RYG 06:30, 09:00, 13:00; 09:00 FULL not flagged.
- distortions: [{"type": "FULL_ROUND_NOT_FLAGGED", "severity": "medium", "detail": "BKK-RYG-STD Sat 21 09:00 is FULL (capacity=reserved) per DB slot a170b57c; compact timetable lists it as a normal departure with no \"เต็ม\" mark", "code": "slots/slot-answer.ts:111-120,173-215"}]

---

### FC2 · followup · conv `conv-C` turn 2

**Input:** ขึ้นรถที่ไหน

**Flow:** คาด `KNOWLEDGE` → ได้ `KNOWLEDGE` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `DIRECT` · routeSource `CACHE` · reason: knowledge retrieval selected DIRECT
- answerType `KNOWLEDGE` · answerMode `DIRECT_PRESET` · action `ANSWER_KNOWLEDGE` · matchType `None`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 0 call · 0 in / 0 out · 168 ms · commerceTurn `None`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | [TEST] จุดขึ้นรถ | ✓ | - | 6.903 | EXACT |
| 2 | ANSWER_PATTERN | [TEST] สัมภาระ |  | - | 3.722 | KEYWORD |
| 3 | ANSWER_PATTERN | ช่องทางติดต่อ BKS (บขส.) |  | - | 2.293 | KEYWORD |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขึ้นรถได้ที่ท่ารถตามที่ระบุบนตั๋ว เช่น สถานีหมอชิต 2 หรือสถานีเอกมัย กรุณามาถึงก่อนเวลารถออกอย่างน้อย 30 นาทีค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · FAQ pickup point matches AP row 391f3b0a exactly.

---

### FC3 · followup · conv `conv-C` turn 3

**Input:** แล้วรอบถัดไปล่ะ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_UNMATCHED_SUGGESTIONS` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 14480 in / 795 out · 6701 ms · commerceTurn `b792e849-88fa-4b43-8a41-1ebf508f8eae`
- plan: mode `PRODUCT` · operation `NEXT` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 06:30 | AVAILABLE | 11 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ค่ะ
> เส้นทางที่ใกล้เคียง: กรุงเทพฯ → ระยอง สนใจเส้นทางไหนแจ้งได้เลยค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · "แล้วรอบถัดไปล่ะ": plan resolved BKK->RYG from history, search FOUND slot 06:30 (MATCHED), but reply says "ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ ... กรุงเทพฯ → ระยอง". Contradicts own evidence. Cause: askFields non-empty -> isScheduleLookup=false -> LLM returned directlyAnswered=false placeholder -> treated as INSUFFICIENT -> unmatchedProductAnswer. Context was NOT lost.
- distortions: [{"type": "CONTRADICTS_EVIDENCE", "severity": "high", "detail": "Evidence SLOT 29d9e713 (RYG Sat 21 06:30, 11 seats) existed; reply said route not found", "code": "slots/slot-answer.ts:237; rag/product-answer.service.ts:194,232-253; rag/product-answer.policy.ts:566-568"}]

---

### P10 · product · conv `s-P10` turn 1

**Input:** วันเสาร์นี้ กรุงเทพไปหัวหินกี่โมงบ้าง

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7697 in / 258 out · 2749 ms · commerceTurn `8d9f95dd-6b12-4487-8120-adba20e7bff7`
- plan: mode `PRODUCT` · operation `LIST` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ส. 21/11 08:00 | AVAILABLE | 10 | REQUESTED |
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ส. 21/11 12:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ส. 21/11 16:00 | LOW | 5 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - หัวหิน (เสาร์ 21 พ.ย.)
> • กรุงเทพฯ 08:00, 12:00, 16:00
> ราคาต่อคน 250 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 HHN 08:00,12:00,16:00 correct, 250 correct; 12:00 FULL (13/13) not flagged.
- distortions: [{"type": "FULL_ROUND_NOT_FLAGGED", "severity": "medium", "detail": "BKK-HHN-STD Sat 21 12:00 is FULL (capacity=reserved) per DB slot 4c3f5407; compact timetable lists it as a normal departure with no \"เต็ม\" mark", "code": "slots/slot-answer.ts:111-120,173-215"}]

---

### P06 · product · conv `s-P06` turn 1

**Input:** รอบสุดท้ายคืนนี้ไปหัวหิน

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7356 in / 602 out · 4181 ms · commerceTurn `221a3e1e-ab02-42a1-845b-34a6178710bc`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-20", "after": "18:00", "before": null}` · search status `FOUND` · slotOutcome `NO_SLOT_IN_WINDOW` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `NO_SLOT_IN_WINDOW`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ศ. 20/11 17:30 | AVAILABLE | 12 | ALTERNATIVE |
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ศ. 20/11 13:00 | LOW | 4 | ALTERNATIVE |
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ศ. 20/11 09:00 | AVAILABLE | 8 | ALTERNATIVE |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ไม่พบรอบ ศุกร์ 20 พ.ย. หลัง 18:00 น. ของ กรุงเทพฯ → หัวหิน ค่ะ
> 
> รอบใกล้เคียงที่ยังไปได้:
> • ศุกร์ 20 พ.ย. 17:30 น. · ถึงประมาณ 21:00 น. · 250.00 บาท
> • ศุกร์ 20 พ.ย. 13:00 น. · ถึงประมาณ 16:30 น. · 250.00 บาท
> • ศุกร์ 20 พ.ย. 09:00 น. · ถึงประมาณ 12:30 น. · 250.00 บาท

**ตรวจสอบกับ DB:** evidenceInDb `True` · No HHN round after 18:00 on Fri 20 (DB: 09:00,13:00,17:30); offers 17:30 (left 12), 13:00, 09:00. Correct.

---

### P13 · product · conv `s-P13` turn 1

**Input:** รถไปขอนแก่นคืนนี้มีไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7353 in / 530 out · 3775 ms · commerceTurn `a53d9d46-9d3d-438d-baeb-5be879c3c5a9`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-20", "after": "18:00", "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ขอนแก่น | BKK-KKC-STD | 480.00–520.00 | ศ. 20/11 22:00 | UNKNOWN | None | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - ขอนแก่น (ศุกร์ 20 พ.ย.)
> • กรุงเทพฯ 22:00
> ราคาต่อคนประมาณ 480–520 บาท ราคาอาจต่างกันในแต่ละรอบ
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · KKC Fri 20 22:00, price 480-520 (variant range, approximate); capacity NULL so no seat claim. Correct.

---

### P15 · product · conv `s-P15` turn 1

**Input:** ไปเกาะช้างพรุ่งนี้มีรอบไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7358 in / 221 out · 2401 ms · commerceTurn `d379da3f-b567-4e5d-b0de-34638b3b150b`
- plan: mode `PRODUCT` · operation `LIST` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เกาะช้าง | BKK-KCH-TRN | 750.00 | ส. 21/11 06:00 | AVAILABLE | 12 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - เกาะช้าง (เสาร์ 21 พ.ย.)
> • กรุงเทพฯ 06:00
> ราคาต่อคน 750 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 06:00, 750 correct; DB 12 seats (not stated).

---

### P16 · product · conv `s-P16` turn 1

**Input:** ไปเกาะช้างวันจันทร์

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7348 in / 604 out · 3781 ms · commerceTurn `1788f0a1-01c2-49ff-a188-0b7cb417d5b9`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-23", "after": null, "before": null}` · search status `FOUND` · slotOutcome `NO_SLOT_IN_WINDOW` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `NO_SLOT_IN_WINDOW`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เกาะช้าง | BKK-KCH-TRN | 750.00 | ส. 21/11 06:00 | AVAILABLE | 12 | ALTERNATIVE |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ไม่พบรอบ จันทร์ 23 พ.ย. ของ กรุงเทพฯ → เกาะช้าง ค่ะ
> 
> รอบใกล้เคียงที่ยังไปได้:
> • เสาร์ 21 พ.ย. 06:00 น. · ถึงประมาณ 12:00 น. · 750.00 บาท

**ตรวจสอบกับ DB:** evidenceInDb `True` · Mon 23 round is CANCELLED -> "no round" correct, but the only alternative shown is Sat 21 06:00 while Sun 22 06:00 (OPEN, 4 left) is nearer. Alternative picked by "earliest in horizon", not nearest.
- distortions: [{"type": "SUBOPTIMAL_ALTERNATIVE", "severity": "low", "detail": "DB: BKK-KCH-TRN Sun 22 06:00 OPEN left 4 (and Sat 28 06:00 left 17); reply offers Sat 21", "code": "slots/slot-search.ts:378-395"}]

---

### P18 · product · conv `s-P18` turn 1

**Input:** เชียงใหม่ไปกรุงเทพวันเสาร์ 3 ทุ่ม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7755 in / 888 out · 5305 ms · commerceTurn `2e76dd9c-cc29-497d-a23a-579832fbb773`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": "20:30", "before": "21:30"}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `2` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| เชียงใหม่ → กรุงเทพฯ | CNX-BKK-STD | 650.00 | ส. 21/11 21:00 | AVAILABLE | 29 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – เชียงใหม่ - กรุงเทพฯ (เสาร์ 21 พ.ย.)
> • เชียงใหม่ 21:00
> ราคาต่อคน 650 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 CNX-BKK STD 21:00, 650 correct (29 seats).

---

### P19 · product · conv `s-P19` turn 1

**Input:** กรุงเทพไปเชียงใหม่ VIP วันจันทร์

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7747 in / 900 out · 6428 ms · commerceTurn `774b1258-77ea-47c7-89ad-ec819e1de2bf`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN returned empty text (all 900 tokens reasoning) -> fallback+handoff. DB: Mon 23 VIP 21:00 CANCELLED; Sun 22 VIP 21:00 left 14 should be offered.
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: Mon 23 VIP CANCELLED; Sun 22 21:00 VIP left 14", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### P21 · product · conv `s-P21` turn 1

**Input:** กรุงเทพไปเชียงใหม่พรุ่งนี้ 4 ทุ่มที่ว่างไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7764 in / 726 out · 4687 ms · commerceTurn `769b525c-4d2e-4df5-8122-c50f0db3f279`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE', 'STOCK'] · when `{"date": "2026-11-21", "after": "21:30", "before": "22:30"}` · search status `FOUND` · slotOutcome `NONE_FITS` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `NONE_FITS`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 21/11 22:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | ส. 21/11 21:00 | AVAILABLE | 18 | ALTERNATIVE |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ส. 21/11 20:30 | AVAILABLE | 15 | ALTERNATIVE |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | อา. 22/11 20:30 | AVAILABLE | 31 | ALTERNATIVE |

**คำตอบสุดท้ายของ LLM / ระบบ**

> รอบรถ กรุงเทพฯ → เชียงใหม่ เสาร์ 21 พ.ย.
> • 22:00 น. · ถึงประมาณ 07:30 น. (วันถัดไป) · 650.00 บาท · ที่นั่งเต็ม
> 
> รอบใกล้เคียงที่ยังไปได้:
> • เสาร์ 21 พ.ย. 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท · มีที่นั่งว่าง · เหลือ 18 ที่นั่ง
> • เสาร์ 21 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท · มีที่นั่งว่าง · เหลือ 15 ที่นั่ง
> • อาทิตย์ 22 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท · มีที่นั่งว่าง · เหลือ 31 ที่นั่ง

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 22:00 STD FULL stated; alternatives 21:00 VIP(18), 20:30 STD(15), Sun 22 20:30(31) all match DB.

---

### P22 · product · conv `s-P22` turn 1

**Input:** VIP กรุงเทพเชียงใหม่คืนนี้เหลือกี่ที่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7753 in / 274 out · 14934 ms · commerceTurn `176c7c8a-0da6-4d16-bac6-f01a4909d924`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['STOCK', 'SCHEDULE'] · when `{"date": "2026-11-20", "after": "18:00", "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | ศ. 20/11 21:00 | LOW | 2 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> รอบรถ กรุงเทพฯ → เชียงใหม่ ศุกร์ 20 พ.ย.
> • 21:00 น. · ถึงประมาณ 06:30 น. (วันถัดไป) · 990.00 บาท · ที่นั่งใกล้เต็ม · เหลือ 2 ที่นั่ง

**ตรวจสอบกับ DB:** evidenceInDb `True` · VIP Fri 20 21:00 990, 2 seats left matches DB (24-22).

---

### P24 · product · conv `s-P24` turn 1

**Input:** กรุงเทพ พัทยา วันที่ 28 พ.ย. ราคา

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7528 in / 266 out · 2527 ms · commerceTurn `507fe6d7-756c-4138-9735-59fc5d8db345`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE', 'SCHEDULE'] · when `{"date": "2026-11-28", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | ส. 28/11 07:00 | AVAILABLE | 40 | REQUESTED |
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | ส. 28/11 10:00 | AVAILABLE | 40 | REQUESTED |
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | ส. 28/11 14:00 | AVAILABLE | 40 | REQUESTED |
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | ส. 28/11 18:00 | AVAILABLE | 40 | REQUESTED |
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | ส. 28/11 21:00 | AVAILABLE | 40 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - พัทยา (เสาร์ 28 พ.ย.)
> • กรุงเทพฯ 07:00, 10:00, 14:00, 18:00, 21:00
> ราคาต่อคน 350 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 28 BKK->PTY 07,10,14,18,21 price 350 match DB.

---

### P26 · product · conv `s-P26` turn 1

**Input:** กรุงเทพไประยองราคาเท่าไหร่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13338 in / 1057 out · 12673 ms · commerceTurn `95de21cb-5d07-466b-b8cd-bdcf5099379b`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> เส้นทาง กรุงเทพฯ → ระยอง มีราคาโดยสาร 280.00 บาท ค่ะ ราคาอาจเปลี่ยนแปลงได้ หากต้องการยืนยันก่อนเดินทาง แนะนำให้ตรวจสอบกับช่องทางจองตั๋วหรือเจ้าหน้าที่บขส. อีกครั้งนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · 280 baht matches variant price.

---

### P27 · product · conv `s-P27` turn 1

**Input:** พัทยาไปกรุงเทพราคาเท่าไร

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13494 in / 783 out · 6329 ms · commerceTurn `71100b7b-14fe-4629-b1a8-e1cc20efc4e5`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00–350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> พัทยา → กรุงเทพฯ · ราคา 316.00–350.00 บาท (ราคาขึ้นกับรอบ)

**ตรวจสอบกับ DB:** evidenceInDb `True` · 316-350 for PTY->BKK matches slot prices.

---

### P28 · product · conv `s-P28` turn 1

**Input:** กรุงเทพไปขอนแก่นราคา

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13408 in / 1498 out · 8785 ms · commerceTurn `dcb215e0-7983-44cc-8eb1-3bac04f81121`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ขอนแก่น | BKK-KKC-STD | 480.00–520.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> กรุงเทพฯ → ขอนแก่น · ราคา 480.00–520.00 บาท (ราคาโดยประมาณ ยืนยันอีกครั้งก่อนเดินทาง)

**ตรวจสอบกับ DB:** evidenceInDb `True` · 480-520 approximate matches variant range.

---

### P30 · product · conv `s-P30` turn 1

**Input:** กรุงเทพไปภูเก็ต

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7513 in / 900 out · 7897 ms · commerceTurn `aadaaf1b-55e6-4c5f-92bb-8410db715f4e`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN truncated -> fallback+handoff. No product route to ภูเก็ต, but active microKnowledge "ตารางเดินรถหลัก กรุงเทพมหานคร - ภูเก็ต" exists, so legacy KB could answer; fallback skips it.
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: no product; MK Phuket timetable row exists (active)", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### P33 · product · conv `s-P33` turn 1

**Input:** ไปเกาะช้างเป็นรถประจำทางไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13148 in / 1374 out · 8751 ms · commerceTurn `0c17350b-d694-416f-a222-bb19ba592a6a`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['ATTRIBUTES'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เกาะช้าง | BKK-KCH-TRN | 750.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> จากข้อมูลของระบบ กรุงเทพฯ → เกาะช้าง ระบุสถานะรถประจำทางเป็น "ไม่มี" ค่ะ หากต้องการความแน่นอนเพิ่มเติม แนะนำให้ตรวจสอบกับช่องทางจองตั๋วหรือเจ้าหน้าที่ BKS ได้เลยนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · KCH is_regular_bus=false: reply says status "ไม่มี". Correct, slightly awkward wording.

---

### P34 · product · conv `s-P34` turn 1

**Input:** กรุงเทพไประยองเป็นรถประจำทางหรือเปล่า

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13373 in / 616 out · 5187 ms · commerceTurn `2c830ed1-527f-4471-888c-d300e4ea51f4`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['ATTRIBUTES'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> กรุงเทพฯ → ระยอง · รถประจำทาง: มี

**ตรวจสอบกับ DB:** evidenceInDb `True` · RYG is_regular_bus=true: "มี". Correct.

---

### P08 · product · conv `s-P08` turn 1

**Input:** กรุงเทพไประยองพรุ่งนี้ 06:30 ไป 3 คนพอไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7692 in / 900 out · 7331 ms · commerceTurn `d86ad121-9a69-4035-96d9-84cc6c68338a`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN truncated -> generic fallback+handoff. DB: BKK-RYG Sat 21 06:30 has 11 seats (enough for 3).
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: BKK-RYG-STD Sat 21 06:30 left 11", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### P47 · product · conv `s-P47` turn 1

**Input:** 5 ธ.ค. กรุงเทพไปพัทยามีกี่รอบ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7528 in / 900 out · 6201 ms · commerceTurn `e59839f0-1c66-45dc-b29e-e188b12fb740`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN truncated. DB: BKK-PTY Sat 5 Dec has 5 OPEN rounds (07,10,14,18,21) 350.
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: BKK-PTY Sat 5 Dec 07:00,10:00,14:00,18:00,21:00", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### P50 · product · conv `s-P50` turn 1

**Input:** ตอนนี้มีรถไปพัทยาไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `True` · fallbackReason `PRODUCT_PLAN_FAILED` · handoff `True`
- LLM 1 call · 7518 in / 900 out · 5914 ms · commerceTurn `eab09a7a-fd76-4156-95c0-c3922db940d9`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `True`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PLAN truncated. DB: no BKK->PTY round on Fri 20; next is Sat 21 07:00.
- distortions: [{"type": "UNNECESSARY_FALLBACK_PLAN_TRUNCATED", "severity": "high", "detail": "PLAN call finishReason=length at 900 output tokens (reasoning tokens consumed budget); bot said \"ขอให้เจ้าหน้าที่ช่วยตรวจสอบ\" + handoff although DB has: BKK-PTY Sat 21 07:00 next round", "code": "rag/product-retrieval.service.ts:297-298"}]

---

### FB1 · followup · conv `conv-B` turn 1

**Input:** พัทยาไปกรุงเทพ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13478 in / 875 out · 5837 ms · commerceTurn `93a1c85a-232a-4cb9-8bad-edfed87b2de9`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00–350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> พัทยา → กรุงเทพฯ มีราคาโดยสารประมาณ 316.00–350.00 บาท (ราคาขึ้นกับรอบ) ค่ะ
> 
> ราคาอาจต่างกันตามรอบเดินทาง หากบอกวันที่ที่ต้องการเดินทาง จะช่วยเช็กราคาของรอบนั้นให้ได้เลยค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · PTY->BKK price range, asks date.

---

### FB2 · followup · conv `conv-B` turn 2

**Input:** พรุ่งนี้

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7637 in / 628 out · 5175 ms · commerceTurn `955a0e29-a16a-4197-9d5f-a86c44f16693`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE', 'PRICE'] · when `{"date": "2026-11-21", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | ส. 21/11 07:00 | AVAILABLE | 35 | REQUESTED |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | ส. 21/11 14:00 | AVAILABLE | 28 | REQUESTED |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 350.00 | ส. 21/11 17:30 | AVAILABLE | 20 | REQUESTED |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 350.00 | ส. 21/11 20:00 | AVAILABLE | 10 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – พัทยา - กรุงเทพฯ (เสาร์ 21 พ.ย.)
> • พัทยา 07:00, 14:00, 17:30, 20:00
> ราคาต่อคนประมาณ 316–350 บาท ราคาอาจต่างกันในแต่ละรอบ
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 PTY->BKK 07,14,17:30,20 (10:00 cancelled excluded) correct.

---

### FB3 · followup · conv `conv-B` turn 3

**Input:** บ่ายๆ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 8317 in / 893 out · 5915 ms · commerceTurn `20b5cf4c-1879-4b89-83d0-f29df17b7ad5`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": "12:00", "before": "16:00"}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00 | ส. 21/11 14:00 | AVAILABLE | 28 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – พัทยา - กรุงเทพฯ (เสาร์ 21 พ.ย.)
> • พัทยา 14:00
> ราคาต่อคน 316 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Afternoon window 12-16 -> 14:00 only; correct.

---

### FD1 · followup · conv `conv-D` turn 1

**Input:** กรุงเทพไปหัวหินพรุ่งนี้

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7684 in / 277 out · 3067 ms · commerceTurn `dfb16635-88e3-4e4a-baca-bcbbdb4aaec6`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ส. 21/11 08:00 | AVAILABLE | 10 | REQUESTED |
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ส. 21/11 12:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → หัวหิน | BKK-HHN-STD | 250.00 | ส. 21/11 16:00 | LOW | 5 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - หัวหิน (เสาร์ 21 พ.ย.)
> • กรุงเทพฯ 08:00, 12:00, 16:00
> ราคาต่อคน 250 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 HHN 08:00,12:00,16:00; 12:00 FULL not flagged.
- distortions: [{"type": "FULL_ROUND_NOT_FLAGGED", "severity": "medium", "detail": "BKK-HHN-STD Sat 21 12:00 is FULL (capacity=reserved) per DB slot 4c3f5407; compact timetable lists it as a normal departure with no \"เต็ม\" mark", "code": "slots/slot-answer.ts:111-120,173-215"}]

---

### FD2 · followup · conv `conv-D` turn 2

**Input:** เปลี่ยนเป็นไประยองแทน

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 8014 in / 585 out · 5126 ms · commerceTurn `b8c1e50a-edd1-4953-8abe-d387deef59c5`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": null, "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 06:30 | AVAILABLE | 11 | REQUESTED |
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 09:00 | FULL | 0 | REQUESTED |
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | ส. 21/11 13:00 | AVAILABLE | 7 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - ระยอง (เสาร์ 21 พ.ย.)
> • กรุงเทพฯ 06:30, 09:00, 13:00
> ราคาต่อคน 280 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Destination changed to RYG, keeps Sat 21; 09:00 FULL not flagged.
- distortions: [{"type": "FULL_ROUND_NOT_FLAGGED", "severity": "medium", "detail": "BKK-RYG-STD Sat 21 09:00 is FULL (capacity=reserved) per DB slot a170b57c; compact timetable lists it as a normal departure with no \"เต็ม\" mark", "code": "slots/slot-answer.ts:111-120,173-215"}]

---

### D03 · decoy · conv `s-D03` turn 1

**Input:** ชำระเงินยังไง

**Flow:** คาด `KNOWLEDGE` → ได้ `KNOWLEDGE` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `DIRECT` · routeSource `CACHE` · reason: knowledge retrieval selected DIRECT
- answerType `KNOWLEDGE` · answerMode `DIRECT_PRESET` · action `ANSWER_KNOWLEDGE` · matchType `None`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 0 call · 0 in / 0 out · 207 ms · commerceTurn `None`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | [TEST] ช่องทางชำระเงิน | ✓ | - | 11.106 | EXACT |
| 2 | ANSWER_PATTERN | ช่องทางจองตั๋ว BKS E-Ticket |  | - | 7.120 | KEYWORD |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ชำระเงินได้ผ่านแอป BKS E-Ticket ด้วยพร้อมเพย์ QR บัตรเครดิต/เดบิต และเคาน์เตอร์เซอร์วิสค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Equals AP 0c6aac65.

---

### D05 · decoy · conv `s-D05` turn 1

**Input:** เอาสัตว์เลี้ยงขึ้นรถได้ไหม

**Flow:** คาด `FALLBACK` → ได้ `FALLBACK` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `LOW_CONFIDENCE` · routeSource `AI` · reason: product planner classified KNOWLEDGE
- answerType `KNOWLEDGE` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `HYBRID`
- isFallback `True` · fallbackReason `INSUFFICIENT_CONTEXT` · handoff `True`
- LLM 2 call · 12755 in / 686 out · 6803 ms · commerceTurn `None`
- plan: mode `KNOWLEDGE` · operation `DETAIL` · asks ['POLICY'] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | [TEST] สัมภาระ | ✓ | 0.700 | 9.972 | KEYWORD,EMBEDDING |
| 2 | ANSWER_PATTERN | [TEST] จุดขึ้นรถ | ✓ | 0.676 | 3.938 | KEYWORD,EMBEDDING |
| 3 | ANSWER_PATTERN | [MOCK] ตารางเดินรถ (ภาพรวม) | ✓ | 0.629 | 1.252 | KEYWORD,EMBEDDING |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · No pet KB -> fallback+handoff correct.

---

### D06 · decoy · conv `s-D06` turn 1

**Input:** สัมภาระเอาขึ้นรถได้กี่กิโล

**Flow:** คาด `KNOWLEDGE` → ได้ `KNOWLEDGE` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `EMBEDDING` · reason: knowledge retrieval selected RAG
- answerType `KNOWLEDGE` · answerMode `GROUNDED` · action `ANSWER_KNOWLEDGE` · matchType `HYBRID`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 12806 in / 411 out · 5305 ms · commerceTurn `None`
- plan: mode `KNOWLEDGE` · operation `DETAIL` · asks ['ATTRIBUTES'] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | [TEST] สัมภาระ | ✓ | 0.799 | 20.531 | KEYWORD,EMBEDDING |
| 2 | ANSWER_PATTERN | [TEST] จุดขึ้นรถ | ✓ | 0.681 | 4.383 | KEYWORD,EMBEDDING |
| 3 | ANSWER_PATTERN | รถโดยสารใหม่ Euro 5 | ✓ | 0.636 | 3.874 | KEYWORD,EMBEDDING |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> นำสัมภาระขึ้นรถได้ท่านละไม่เกิน 20 กิโลกรัม และกระเป๋าถือขึ้นรถได้ 1 ใบค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · 20 kg + 1 carry-on equals AP 222918b1.

---

### D07 · decoy · conv `s-D07` turn 1

**Input:** ติดต่อแอดมิน

**Flow:** คาด `FALLBACK` → ได้ `FALLBACK` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `None` · routeSource `RULE` · reason: contact admin keyword -> CONTACT_ADMIN
- answerType `HANDOFF` · answerMode `TEMPLATE` · action `CONTACT_ADMIN` · matchType `None`
- isFallback `False` · fallbackReason `None` · handoff `True`
- LLM 0 call · 0 in / 0 out · 169 ms · commerceTurn `None`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> รับทราบค่ะ เดี๋ยวแอดมินจะเข้ามาดูแลให้นะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Template ack + handoff.

---

### D09 · decoy · conv `s-D09` turn 1

**Input:** ขอบคุณค่ะ

**Flow:** คาด `GENERAL` → ได้ `GENERAL` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan GENERAL
- answerType `GENERAL` · answerMode `GENERAL` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 9403 in / 242 out · 4253 ms · commerceTurn `92e82b28-d0d9-465b-be0b-ac25b4ee1e91`
- plan: mode `GENERAL` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ยินดีค่ะ 😊 หากมีคำถามเรื่องรอบรถ เส้นทาง ค่าโดยสาร หรือสถานีขึ้นลงรถ สอบถามได้เลยนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Thanks reply.

---

### D10 · decoy · conv `s-D10` turn 1

**Input:** วันนี้อากาศเป็นไง

**Flow:** คาด `GENERAL` → ได้ `GENERAL` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan GENERAL
- answerType `GENERAL` · answerMode `GENERAL` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 9409 in / 319 out · 5271 ms · commerceTurn `50619f06-228e-45c3-b8b9-8f2fcdd0213d`
- plan: mode `GENERAL` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-20", "after": null, "before": null}` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ ตอนนี้ดิฉันไม่สามารถเช็กสภาพอากาศได้ เพราะเป็นข้อมูลนอกขอบเขตของบริการแอดมิน บขส ค่ะ
> 
> หากวางแผนเดินทางด้วยรถโดยสาร สามารถสอบถามรอบรถ เวลาออก หรือค่าโดยสารได้เลยนะคะ 🚌

**ตรวจสอบกับ DB:** evidenceInDb `True` · Polite refusal on weather; not product.

---

### D11 · decoy · conv `s-D11` turn 1

**Input:** แนะนำร้านอาหารพัทยาหน่อย

**Flow:** คาด `GENERAL` → ได้ `PRODUCT` ❌ · ตรวจสอบ: **FAIL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_UNMATCHED_SUGGESTIONS` · action `ANSWER_KNOWLEDGE` · matchType `HYBRID`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13872 in / 350 out · 5085 ms · commerceTurn `b93dcc9f-486c-4393-b630-574620500d3b`
- plan: mode `PRODUCT` · operation `RECOMMEND` · asks [] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | - | - | - | - |
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00–350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ค่ะ
> เส้นทางที่ใกล้เคียง: กรุงเทพฯ → พัทยา / พัทยา → กรุงเทพฯ สนใจเส้นทางไหนแจ้งได้เลยค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Restaurant question: planner said GENERAL but code clamps to PRODUCT because probe matched พัทยา; reply "ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ ... กรุงเทพฯ → พัทยา / พัทยา → กรุงเทพฯ" is off-topic (LLM had written a polite refusal that was discarded).
- distortions: [{"type": "OFF_TOPIC_PRODUCT_ROUTING", "severity": "medium", "detail": "planner mode GENERAL overridden to PRODUCT", "code": "rag/product-retrieval.service.ts:379-381"}]

---

### D14 · decoy · conv `s-D14` turn 1

**Input:** บริษัทตั้งอยู่ที่ไหน

**Flow:** คาด `KNOWLEDGE` → ได้ `KNOWLEDGE` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `LOW_CONFIDENCE` · routeSource `AI` · reason: product planner classified KNOWLEDGE
- answerType `KNOWLEDGE` · answerMode `GROUNDED` · action `ANSWER_KNOWLEDGE` · matchType `HYBRID`
- isFallback `False` · fallbackReason `BELOW_MIN_VECTOR_SIMILARITY` · handoff `False`
- LLM 2 call · 13215 in / 385 out · 5796 ms · commerceTurn `None`
- plan: mode `KNOWLEDGE` · operation `DETAIL` · asks [] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | ANSWER_PATTERN | ช่องทางติดต่อ BKS (บขส.) | ✓ | 0.676 | 7.330 | KEYWORD,EMBEDDING |
| 2 | ANSWER_PATTERN | [TEST] จุดขึ้นรถ | ✓ | 0.625 | 2.958 | KEYWORD,EMBEDDING |
| 3 | MICRO_KNOWLEDGE | ตารางเดินรถหลัก ภูเก็ต - กรุงเทพมหานคร | ✓ | - | 1.741 | KEYWORD |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> สำนักงานใหญ่ บขส. ตั้งอยู่ที่ 999 ถ.กำแพงเพชร 2 แขวงจตุจักร เขตจตุจักร กรุงเทพฯ ค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · HQ address equals AP a14808f9.

---

### D15 · decoy · conv `s-D15` turn 1

**Input:** ทำไมรถเมื่อวานมาช้า

**Flow:** คาด `FALLBACK` → ได้ `FALLBACK` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `LOW_CONFIDENCE` · routeSource `AI` · reason: product planner classified KNOWLEDGE
- answerType `MIXED_KNOWLEDGE` · answerMode `FALLBACK` · action `ANSWER_KNOWLEDGE` · matchType `HYBRID`
- isFallback `True` · fallbackReason `INSUFFICIENT_CONTEXT` · handoff `True`
- LLM 2 call · 12399 in / 582 out · 5818 ms · commerceTurn `None`
- plan: mode `KNOWLEDGE` · operation `DETAIL` · asks ['POLICY'] · when `null` · search status `NO_MATCH` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

| # | แหล่ง | title | เลือก | vector | lexical | match |
|---|---|---|---|---|---|---|
| 1 | MICRO_KNOWLEDGE | สอบถามรอบรถ | ✓ | 0.653 | 0.100 | KEYWORD,EMBEDDING |
| 2 | ANSWER_PATTERN | [TEST] จุดขึ้นรถ | ✓ | 0.639 | 1.857 | KEYWORD,EMBEDDING |
| 3 | ANSWER_PATTERN | รถโดยสารใหม่ Euro 5 | ✓ | 0.619 | 2.034 | KEYWORD,EMBEDDING |

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Complaint -> fallback+handoff as expected.

---

### P35 · product · conv `s-P35` turn 1

**Input:** พัทยาาาาไปกทม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13311 in / 1048 out · 6808 ms · commerceTurn `5285487e-e76f-43f7-9d85-d699aa24687f`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00–350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> พัทยา → กรุงเทพฯ · ราคา 316.00–350.00 บาท (ราคาขึ้นกับรอบ)

**ตรวจสอบกับ DB:** evidenceInDb `True` · Typo handled: PTY->BKK 316-350.

---

### P36 · product · conv `s-P36` turn 1

**Input:** บางกอกไปเชียงใหม่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13881 in / 1863 out · 12365 ms · commerceTurn `277e628d-9b54-433e-937b-54950a33c73d`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `2` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | - | - | - | - |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00–1090.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> กรุงเทพฯ → เชียงใหม่ · รถทัวร์ข้ามคืนจากกรุงเทพฯ (หมอชิต 2) ไปเชียงใหม่ ใช้เวลาประมาณ 9-10 ชั่วโมง มีชั้น Standard และ VIP · ต้นทาง: กรุงเทพฯ, ปลายทาง: เชียงใหม่, รถประจำทาง: มี
> - ราคา 650.00 บาท
> - ราคา 990.00–1090.00 บาท (ราคาขึ้นกับรอบ)

**ตรวจสอบกับ DB:** evidenceInDb `True` · Right route and prices but safe template dumps description and two unlabeled "ราคา" bullet lines (650 / 990-1090); verbose; no class labels.
- distortions: [{"type": "UNLABELED_VARIANTS", "severity": "low", "detail": "prices not tied to Standard/VIP", "code": "rag/product-answer.policy.ts:945-956"}]

---

### P37 · product · conv `s-P37` turn 1

**Input:** bkk to cnx tonight

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7341 in / 675 out · 4722 ms · commerceTurn `1c2df566-355f-49ef-9bfb-5ff55f58555f`
- plan: mode `PRODUCT` · operation `LIST` · asks ['SCHEDULE'] · when `{"date": "2026-11-20", "after": "18:00", "before": null}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `2` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 20:30 | AVAILABLE | 26 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00 | ศ. 20/11 21:00 | LOW | 2 | REQUESTED |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 22:00 | AVAILABLE | 20 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - เชียงใหม่ (ศุกร์ 20 พ.ย.)
> • กรุงเทพฯ 20:30, 21:00, 22:00
> ราคาต่อคนประมาณ 650–990 บาท ราคาอาจต่างกันในแต่ละรอบ
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Fri 20 BKK->CNX 20:30,21:00,22:00 correct. Price shown as range 650-990 without saying 21:00 is the VIP round (2 seats left).

---

### P38 · product · conv `s-P38` turn 1

**Input:** Bangkok to Pattaya tomorrow morning

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7349 in / 550 out · 3536 ms · commerceTurn `3e577bd2-8659-4549-8ea6-556343068964`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-21", "after": "06:00", "before": "12:00"}` · search status `FOUND` · slotOutcome `MATCHED` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `MATCHED`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | ส. 21/11 07:00 | AVAILABLE | 40 | REQUESTED |
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | ส. 21/11 10:00 | AVAILABLE | 40 | REQUESTED |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ตารางเดินรถหลัก (รอบออกจากต้นทาง) – กรุงเทพฯ - พัทยา (เสาร์ 21 พ.ย.)
> • กรุงเทพฯ 07:00, 10:00
> ราคาต่อคน 350 บาท
> หากต้องการเลือกปลายทางหรือสถานีต้นทาง แจ้งได้เลยค่ะ รอบเวลาอาจเปลี่ยนแปลง กรุณาตรวจสอบก่อนเดินทางนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Sat 21 morning 07:00,10:00 price 350 correct.

---

### P39 · product · conv `s-P39` turn 1

**Input:** Pattaya to Bangkok price

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SAFE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13143 in / 949 out · 6922 ms · commerceTurn `7e2f271a-c2ed-4b5d-a360-45ee5059e12b`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['PRICE'] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| พัทยา → กรุงเทพฯ | PTY-BKK-STD | 316.00–350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> พัทยา → กรุงเทพฯ · ราคา 316.00–350.00 บาท (ราคาขึ้นกับรอบ)

**ตรวจสอบกับ DB:** evidenceInDb `True` · PTY->BKK 316-350 correct.

---

### P40 · product · conv `s-P40` turn 1

**Input:** ขอรอบรถค่ะ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_MISSING_INPUT` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7344 in / 501 out · 3667 ms · commerceTurn `edb3ed4e-1e90-4651-a39d-6920046356bc`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `null` · search status `MISSING_INPUT` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ต้องการเดินทางจากที่ไหนไปที่ไหนคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Asks for route; no invented data.

---

### P41 · product · conv `s-P41` turn 1

**Input:** รอบรถ

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_MISSING_INPUT` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7337 in / 178 out · 2089 ms · commerceTurn `90f676b1-cfdc-41e2-947d-39c855a04396`
- plan: mode `PRODUCT` · operation `LIST` · asks ['SCHEDULE'] · when `null` · search status `MISSING_INPUT` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ต้องการเดินทางเส้นทางไหนคะ: กรุงเทพฯ → เกาะช้าง / พัทยา → กรุงเทพฯ / เชียงใหม่ → กรุงเทพฯ / กรุงเทพฯ → พัทยา / กรุงเทพฯ → หัวหิน

**ตรวจสอบกับ DB:** evidenceInDb `True` · Asks route and lists 5 choices out of 8 products without "etc." (list truncated by MAX 5).

---

### P42 · product · conv `s-P42` turn 1

**Input:** เชียงใหม่

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13747 in / 1699 out · 16884 ms · commerceTurn `68a47c88-3003-4250-ab1c-fd517076cf5f`
- plan: mode `PRODUCT` · operation `DETAIL` · asks [] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `None` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | - | - | - | - |
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-VIP | 990.00–1090.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> สวัสดีค่ะ เส้นทางที่เกี่ยวกับเชียงใหม่ที่มีในระบบคือ กรุงเทพฯ → เชียงใหม่ ค่ะ
> 
> รถทัวร์ข้ามคืนจากกรุงเทพฯ (หมอชิต 2) ไปเชียงใหม่ ใช้เวลาประมาณ 9-10 ชั่วโมง มีชั้น Standard และ VIP
> 
> เส้นทางนี้เป็นรถประจำทาง ต้นทางกรุงเทพฯ ปลายทางเชียงใหม่ ค่ะ
> 
> ราคาโดยสารเบื้องต้นมีดังนี้
> Standard: 650.00 บาท
> VIP: 990.00–1090.00 บาท (ราคาขึ้นกับรอบ)
> 
> ราคาอาจแตกต่างกันตามรอบเดินทาง หากบอกวันที่ที่ต้องการเดินทาง ทางเราจะช่วยเช็กราคาและรอบรถให้ค่ะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · Reply states the only route related to เชียงใหม่ is กรุงเทพฯ→เชียงใหม่. DB has ACTIVE เชียงใหม่→กรุงเทพฯ with slots. Cause: bare alias "เชียงใหม่" exists only on BKK-CNX product (seed data) so probe resolved one product.
- distortions: [{"type": "FALSE_COMPLETENESS", "severity": "medium", "detail": "\"เส้นทางที่เกี่ยวกับเชียงใหม่ที่มีในระบบคือ กรุงเทพฯ → เชียงใหม่\" while products table has เชียงใหม่ → กรุงเทพฯ ACTIVE", "code": "seed data aliases + rag/product-retrieval.service.ts:602-640 probe"}]

---

### P43 · product · conv `s-P43` turn 1

**Input:** ระยอง

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_LLM_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 2 call · 13002 in / 1118 out · 8829 ms · commerceTurn `9ef79d24-c9fc-4a46-ba5d-6086d753fa4c`
- plan: mode `PRODUCT` · operation `LIST` · asks [] · when `null` · search status `FOUND` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `None`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → ระยอง | BKK-RYG-STD | 280.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> มีเส้นทางที่ไประยองตามข้อมูลของระบบค่ะ
> 
> 🚌 กรุงเทพฯ → ระยอง
> ค่าโดยสาร 280.00 บาท
> 
> หากต้องการทราบรอบรถหรือเวลาออกของวันเดินทางที่สนใจ แจ้งวันที่มาได้เลยนะคะ

**ตรวจสอบกับ DB:** evidenceInDb `True` · RYG 280 correct.

---

### P44 · product · conv `s-P44` turn 1

**Input:** ตีหนึ่งมีรถไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_MISSING_INPUT` · action `ANSWER_KNOWLEDGE` · matchType `NONE`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7347 in / 868 out · 6171 ms · commerceTurn `da902dd1-ab9e-4da9-b223-535af7218cb1`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE', 'STOCK'] · when `{"date": null, "after": "00:30", "before": "01:30"}` · search status `MISSING_INPUT` · slotOutcome `None` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

ไม่มี evidence จาก product

**คำตอบสุดท้ายของ LLM / ระบบ**

> ต้องการเดินทางเส้นทางไหนคะ: กรุงเทพฯ → เกาะช้าง / พัทยา → กรุงเทพฯ / เชียงใหม่ → กรุงเทพฯ / กรุงเทพฯ → พัทยา / กรุงเทพฯ → หัวหิน

**ตรวจสอบกับ DB:** evidenceInDb `True` · No round invented for 01:00; asks route.

---

### P45 · product · conv `s-P45` turn 1

**Input:** สิ้นเดือนไปเชียงใหม่มีรถไหม

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PARTIAL**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7579 in / 787 out · 9366 ms · commerceTurn `c63273ac-6447-4ca7-95e7-bdf806ff1aff`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-11-30", "after": null, "before": null}` · search status `FOUND` · slotOutcome `NO_SLOT_IN_WINDOW` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `2` · slotOutcome `NO_SLOT_IN_WINDOW`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → เชียงใหม่ | BKK-CNX-STD | 650.00 | ศ. 20/11 20:30 | AVAILABLE | 26 | ALTERNATIVE |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ไม่พบรอบ จันทร์ 30 พ.ย. ของ กรุงเทพฯ → เชียงใหม่ ค่ะ
> 
> รอบใกล้เคียงที่ยังไปได้:
> • ศุกร์ 20 พ.ย. 20:30 น. · ถึงประมาณ 06:00 น. (วันถัดไป) · 650.00 บาท

**ตรวจสอบกับ DB:** evidenceInDb `True` · Mon 30 Nov has no round (correct) but alternative is Fri 20 Nov 20:30 (10 days earlier) while Sat 28 Nov 20:30 STD(38) and 21:00 VIP(23) exist and are nearer.
- distortions: [{"type": "SUBOPTIMAL_ALTERNATIVE", "severity": "medium", "detail": "\"later\" fallback takes the first slot in the horizon, not the nearest", "code": "slots/slot-search.ts:378-395"}]

---

### P46 · product · conv `s-P46` turn 1

**Input:** 25 ธ.ค. กรุงเทพไปพัทยา

**Flow:** คาด `PRODUCT` → ได้ `PRODUCT` ✅ · ตรวจสอบ: **PASS**

**RAG serve status**

- route `RAG` · routeSource `DATABASE` · reason: product plan PRODUCT
- answerType `PRODUCT` · answerMode `PRODUCT_SCHEDULE_TEMPLATE` · action `ANSWER_KNOWLEDGE` · matchType `EXACT`
- isFallback `False` · fallbackReason `None` · handoff `False`
- LLM 1 call · 7520 in / 627 out · 3962 ms · commerceTurn `8ed2ad05-a8ba-491b-babd-732285e8326a`
- plan: mode `PRODUCT` · operation `DETAIL` · asks ['SCHEDULE'] · when `{"date": "2026-12-25", "after": null, "before": null}` · search status `FOUND` · slotOutcome `OUT_OF_WINDOW` · plannerFailed `False`

**AnswerPattern / MicroKnowledge**

ไม่มี (ไม่ได้ค้น knowledge หรือไม่มี candidate)

**Product evidence**

search status `FOUND` · total `1` · slotOutcome `OUT_OF_WINDOW`

| เส้นทาง | SKU | ราคา | เวลาออก | สถานะ | ที่นั่ง | role |
|---|---|---|---|---|---|---|
| กรุงเทพฯ → พัทยา | BKK-PTY-STD | 350.00 | - | - | - | - |

**คำตอบสุดท้ายของ LLM / ระบบ**

> ยังไม่มีข้อมูลรอบวันที่ ศุกร์ 25 ธ.ค. ค่ะ เปิดให้ตรวจสอบล่วงหน้า 30 วัน

**ตรวจสอบกับ DB:** evidenceInDb `True` · 25 Dec beyond 30-day horizon (Nov 20 + 30 = Dec 20); DB has no slot after Dec 20. Correct.

---

## 3. เคสที่ไม่ได้รัน (งบ LLM หมด)

- P48
- P49
- P25
- P51
- D16
- D17
- D18
- D19
- D20
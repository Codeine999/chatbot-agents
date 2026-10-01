# Source review inventory

Snapshot ของ 50 ไฟล์ใน src/modules/chatbot รวม 7,696 บรรทัด อ่าน source/tests ประกอบ audit; hash ใช้ระบุ snapshot ไม่ใช่เครื่องมือวัด line coverage

Production code ไม่ได้ถูกแก้โดย audit นี้ ดู user changes เดิมและขอบเขตการทดสอบใน [รายงาน](../../chatbot-core-rag-audit-2026-10-01.th.md)

| ไฟล์ | ประเภท | บรรทัด | SHA-256 |
| --- | --- | --- | --- |
| [src/modules/chatbot/ai-intent-classifier.service.ts](../../../src/modules/chatbot/ai-intent-classifier.service.ts) | production logic | 80 | `3619076c5802dfa997558d715b44992ac04d45300292d7b8caeaf310e3278282` |
| [src/modules/chatbot/ai.module.ts](../../../src/modules/chatbot/ai.module.ts) | type / constant / wiring | 32 | `6146504dfdbdab7c03627e5a124eddffdcbaff09c24deb80b89df97fd1fffd2a` |
| [src/modules/chatbot/aichat.service.ts](../../../src/modules/chatbot/aichat.service.ts) | production logic | 470 | `b38fa71735165f9c0b8696befcc90be2086fa4ffa7c5dda85135400c68066ea6` |
| [src/modules/chatbot/audit/core-chat-e2e.audit.spec.ts](../../../src/modules/chatbot/audit/core-chat-e2e.audit.spec.ts) | test / fixture | 571 | `a16ab9c7985a5eb639e540a98934a23a5c4706d961b366805a960cbe0bf20a59` |
| [src/modules/chatbot/audit/core-chat.harness.ts](../../../src/modules/chatbot/audit/core-chat.harness.ts) | test / fixture | 347 | `c5c981f8ed7f84c161258e9b3f55f47ae74bd5be061287fafa1c3996cf5ba6bc` |
| [src/modules/chatbot/audit/core-rag-review-2026-09-24.audit.spec.ts](../../../src/modules/chatbot/audit/core-rag-review-2026-09-24.audit.spec.ts) | test / fixture | 366 | `bd15069376f2a0f04653763b39adb9271b1ded15e24e23a77ab79a4df41389cf` |
| [src/modules/chatbot/audit/grounded-evidence.audit.spec.ts](../../../src/modules/chatbot/audit/grounded-evidence.audit.spec.ts) | test / fixture | 127 | `dc5b6c07e6f32a8775bd2a28ef42977652dfc1b75c014d7e859ea4a7aac4cf61` |
| [src/modules/chatbot/audit/line-ingress.audit.spec.ts](../../../src/modules/chatbot/audit/line-ingress.audit.spec.ts) | test / fixture | 127 | `fa406ac37343d0b589867587d72bf6648cfbbc23049c3b0785e02ef34795c2ca` |
| [src/modules/chatbot/audit/retrieval-fusion.audit.spec.ts](../../../src/modules/chatbot/audit/retrieval-fusion.audit.spec.ts) | test / fixture | 312 | `71d8e0f23fc6dc2a32230bc783e7aa389135b48bbbd9f46d4eb588a4690a4cc6` |
| [src/modules/chatbot/chatbot.module.ts](../../../src/modules/chatbot/chatbot.module.ts) | type / constant / wiring | 41 | `ee1b65e13a21439ad3c23448cb990131914eee1b63d2ad0c05df6750b6944974` |
| [src/modules/chatbot/chatbot.service.ts](../../../src/modules/chatbot/chatbot.service.ts) | production logic | 354 | `a262276b1cd24577d0452093ffac5dc056c29dd938814e99ca86f1fc460ed51e` |
| [src/modules/chatbot/constants/ai-chat.constants.ts](../../../src/modules/chatbot/constants/ai-chat.constants.ts) | type / constant / wiring | 30 | `e1e2cb138d9eff9dd168d5d5d6ecd9122b8ebb66d8f0342ba475bd479a004807` |
| [src/modules/chatbot/constants/knowledge-routing.constants.ts](../../../src/modules/chatbot/constants/knowledge-routing.constants.ts) | type / constant / wiring | 15 | `e64871b96d8318bdec0c968d5f0a8b07a36baf02f1641f2aed9b094db6c4f5e0` |
| [src/modules/chatbot/constants/low-confidence-classifier.prompt.ts](../../../src/modules/chatbot/constants/low-confidence-classifier.prompt.ts) | type / constant / wiring | 41 | `c1c19bd94ad4a5efeb9f539b2b745984001b8e5d58d20d95c40a92a568918ab4` |
| [src/modules/chatbot/context/ai-provider-context.ts](../../../src/modules/chatbot/context/ai-provider-context.ts) | production logic | 53 | `4e270fc9a711bf10cfc6e0803a5c46f60ddd0f594753426374f5ea0d50472a4b` |
| [src/modules/chatbot/context/load-context.service.ts](../../../src/modules/chatbot/context/load-context.service.ts) | production logic | 216 | `3589be8f6d3b97f5fa79cd9a380b786726940a2e2727573d86d41059764d4089` |
| [src/modules/chatbot/image-analysis.policy.ts](../../../src/modules/chatbot/image-analysis.policy.ts) | production logic | 60 | `fedae253ebc3ecc8a06ddaf67a10290bf7aebb2d00f102b4daf8e3821ebf0f67` |
| [src/modules/chatbot/intent/intent.maps.ts](../../../src/modules/chatbot/intent/intent.maps.ts) | type / constant / wiring | 42 | `eac2a3b191bfcff0d662ada3d6083162c44781ac82da71878e5fb3e10b390752` |
| [src/modules/chatbot/intent/intent.utils.ts](../../../src/modules/chatbot/intent/intent.utils.ts) | type / constant / wiring | 16 | `2dce8a9daa687644818032857f26a2fe05279f4f295ff68ca14c02f4c061ba93` |
| [src/modules/chatbot/intent-router.service.ts](../../../src/modules/chatbot/intent-router.service.ts) | production logic | 404 | `6772842fa801242a798826688d32f4f38a2109bc0194a0241090cc35040f9247` |
| [src/modules/chatbot/knowledge/answer-pattern-cache.service.ts](../../../src/modules/chatbot/knowledge/answer-pattern-cache.service.ts) | production logic | 87 | `5a6aeb57b2cb025682caed623f587e562f83b23cd58aecf634d06569d274b071` |
| [src/modules/chatbot/knowledge/answer-pattern.service.ts](../../../src/modules/chatbot/knowledge/answer-pattern.service.ts) | production logic | 188 | `d1a1645658f64752de5891af0207fa70b07cbbde028e2f02cd962cffd42ed6b4` |
| [src/modules/chatbot/knowledge/knowledge-answer.policy.ts](../../../src/modules/chatbot/knowledge/knowledge-answer.policy.ts) | production logic | 11 | `97aa1509709269e89ace5cae4e2ea6f7cb00177794638ce25c8c4b1cd3c5ba28` |
| [src/modules/chatbot/knowledge/knowledge-retrieval.service.ts](../../../src/modules/chatbot/knowledge/knowledge-retrieval.service.ts) | production logic | 497 | `8d2ce2e0020afe4cf67da06d4729ef54358e4a01b84479736cf0553d4dcaad35` |
| [src/modules/chatbot/knowledge/knowledge-scope.ts](../../../src/modules/chatbot/knowledge/knowledge-scope.ts) | production logic | 38 | `d3961b1af465980fe2295c1efffaff92aa98aa69b6984f119202b1f60330a363` |
| [src/modules/chatbot/knowledge/micro-knowledge.service.ts](../../../src/modules/chatbot/knowledge/micro-knowledge.service.ts) | production logic | 33 | `2a0b9dbaa1c5fd5986f13491d6d9374696ea835e2137fb3793f44ded3e4c4308` |
| [src/modules/chatbot/knowledge/retrieval-query-planner.service.ts](../../../src/modules/chatbot/knowledge/retrieval-query-planner.service.ts) | production logic | 93 | `7a910f682bb7f0543ff34de4e3e83826c4f0fd7394556473e171fdcde27ce665` |
| [src/modules/chatbot/knowledge/semantic-search.service.ts](../../../src/modules/chatbot/knowledge/semantic-search.service.ts) | production logic | 112 | `f400ee0ddaf4011dfdc376ce8085f4d067f0891c6a19bda86bdfb0d6544c81c1` |
| [src/modules/chatbot/knowledge/test/answer-pattern-cache.service.spec.ts](../../../src/modules/chatbot/knowledge/test/answer-pattern-cache.service.spec.ts) | test / fixture | 120 | `751beb7899f28736303f6a6c02bee498c5802a2793e7c5bfc78223b2f79b3b6b` |
| [src/modules/chatbot/knowledge/test/answer-pattern.service.spec.ts](../../../src/modules/chatbot/knowledge/test/answer-pattern.service.spec.ts) | test / fixture | 258 | `f4297295d102813cbe2f4a96488bb62d469fdf167db4b093090f5c086e725827` |
| [src/modules/chatbot/knowledge/test/knowledge-pattern.service.spec.ts](../../../src/modules/chatbot/knowledge/test/knowledge-pattern.service.spec.ts) | test / fixture | 64 | `1a2b0801b98868a562bd8faa65a90045ebb1b7aad3d1e1598cdf4a9d2b448606` |
| [src/modules/chatbot/knowledge/test/knowledge-retrieval.service.spec.ts](../../../src/modules/chatbot/knowledge/test/knowledge-retrieval.service.spec.ts) | test / fixture | 570 | `826f302bad695af125c967e6c0746e094d4a985192696ea6c755b176fe58af19` |
| [src/modules/chatbot/knowledge/test/knowledge-scope.spec.ts](../../../src/modules/chatbot/knowledge/test/knowledge-scope.spec.ts) | test / fixture | 70 | `1042d07221e0fe03732d982228cec00789ea0bd0aaf92eeb9b66c99d1e5a7ecf` |
| [src/modules/chatbot/knowledge/test/knowledge.fixtures.ts](../../../src/modules/chatbot/knowledge/test/knowledge.fixtures.ts) | test / fixture | 63 | `274d89ec30120f53c9ebf2ec65efdd77f3f19c82b6baecad5809b3c6549828c4` |
| [src/modules/chatbot/knowledge/test/micro-knowledge.service.spec.ts](../../../src/modules/chatbot/knowledge/test/micro-knowledge.service.spec.ts) | test / fixture | 76 | `b37fd6ebe7ee2ffb529da679caa8161d9c2022aff30898ad8e6ffcfd374b0849` |
| [src/modules/chatbot/knowledge/test/retrieval-query-planner.spec.ts](../../../src/modules/chatbot/knowledge/test/retrieval-query-planner.spec.ts) | test / fixture | 131 | `0052703aa4855e2c7f76999a05f51582e7b51aced21f87fcc4539609e83be0fe` |
| [src/modules/chatbot/knowledge/test/semantic-search.service.spec.ts](../../../src/modules/chatbot/knowledge/test/semantic-search.service.spec.ts) | test / fixture | 151 | `9c607979b152b68a89bc31193580f27340612c56d725f5830b0ad326297afe1f` |
| [src/modules/chatbot/knowledge/thai-bm25.ts](../../../src/modules/chatbot/knowledge/thai-bm25.ts) | production logic | 121 | `b7b0dc815ce2745baa405fb9114830777680e89a1280e02f3b30f2b1a78236ee` |
| [src/modules/chatbot/menu/rich-menu-reply-cache.service.spec.ts](../../../src/modules/chatbot/menu/rich-menu-reply-cache.service.spec.ts) | test / fixture | 162 | `2c38dccdd8c469bb54707313677ab02af1f6215bccd0fa8d08d4be3641b03026` |
| [src/modules/chatbot/menu/rich-menu-reply-cache.service.ts](../../../src/modules/chatbot/menu/rich-menu-reply-cache.service.ts) | production logic | 154 | `3a7471febb0fcaa09da8ae2f1cbb87c6a16e615a65f6e6a75d5340c1c325d2d8` |
| [src/modules/chatbot/menu/rich-menu-routing.spec.ts](../../../src/modules/chatbot/menu/rich-menu-routing.spec.ts) | test / fixture | 134 | `f1c0ea8e3660c1a4069611ece5697ae8c7033c71ee76d1a11f3f1fedd36e4a73` |
| [src/modules/chatbot/prompt/ai-setting-prompt.composer.spec.ts](../../../src/modules/chatbot/prompt/ai-setting-prompt.composer.spec.ts) | test / fixture | 36 | `7b508ecdb48b86f5fc184edca0f781e23ac71d733b3cfe6396a44f63d418cdf3` |
| [src/modules/chatbot/prompt/ai-setting-prompt.composer.ts](../../../src/modules/chatbot/prompt/ai-setting-prompt.composer.ts) | production logic | 89 | `42bf807e634a3217eb7ee8386ae085953981ae4aff4420c724cc94762f00b29c` |
| [src/modules/chatbot/reply-template.service.ts](../../../src/modules/chatbot/reply-template.service.ts) | production logic | 192 | `b8031c65caf7dbf53d794ebb107b602b448edc3b1936f183bd31275ea5a0dc6b` |
| [src/modules/chatbot/rule-intent.service.ts](../../../src/modules/chatbot/rule-intent.service.ts) | production logic | 67 | `5a41d94ff3d099a81aeaf11d15c47907f1282277245ac8fa76472427612efa7c` |
| [src/modules/chatbot/sticker-intent.service.ts](../../../src/modules/chatbot/sticker-intent.service.ts) | production logic | 89 | `b15b0848813054931d15aa5cf650724f76dc5559eff5f4b733bbfb7c1a864a80` |
| [src/modules/chatbot/types/ai-runtime.types.ts](../../../src/modules/chatbot/types/ai-runtime.types.ts) | type / constant / wiring | 14 | `612fb73783ba1ecce572f039830a726495f2bbe127014795c96fbd9cbb6f505a` |
| [src/modules/chatbot/types/chat.types.ts](../../../src/modules/chatbot/types/chat.types.ts) | type / constant / wiring | 174 | `984e295b0afaca32b4441a28aac18d7af245b7c90269b2c2aa31f369a2bfc742` |
| [src/modules/chatbot/types/session.types.ts](../../../src/modules/chatbot/types/session.types.ts) | type / constant / wiring | 19 | `fb8c506f94e7d9419da547b37cb3dbf18ea0a91829a3766f04d448b59614becd` |
| [src/modules/chatbot/user-session.service.ts](../../../src/modules/chatbot/user-session.service.ts) | production logic | 179 | `b5a2fd10613acaadada7dd0bfec32abd522fdbecac113b5c9426a8fb3a00985f` |

## Boundary files ที่อ่านประกอบ

- LINE webhook / event processor / delivery / reply / push: inbound, ordering, accepted delivery → context
- src/utils/text.utils.ts: normalization, privacy redaction, logging
- src/modules/ai/embeding: query embedding และ AP/Micro vector repositories; scoped SQL/model filtering
- src/modules/ai/ai-setting และ users provider boundary: configuration, provider/billing entry points
- src/modules/admin/knowledge: DTO, create/update, index/cache refresh; ไม่ใช่ security audit ของทุก admin endpoint
- prisma/schema.prisma และ migrations ของ answer patterns, vectors, micro knowledge, AI settings
- docs/line-message-e2e-current.md และ architecture/historical audit ที่เกี่ยวข้อง; source เป็นหลักเมื่อขัดกัน
- test/live/*: ตรวจแนวทางการรันและผลกระทบ แต่ไม่ได้รัน live evaluation


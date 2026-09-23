import type { ConfigService } from '@nestjs/config';
import type { KnowledgeRecord } from '../answer-pattern.service';
import type { ChatContextMessage, KnowledgeItem } from '../../types/chat.types';

/** ConfigService ปลอม อ่านค่าจาก map ที่ส่งเข้ามา คีย์ที่ไม่ได้ตั้ง = undefined */
export const configStub = (
  values: Record<string, string> = {},
): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

/** แถว answerPattern/microKnowledge ที่ผ่าน scope ปริยาย (tenant null, ภาษา th) */
export const makePattern = (
  overrides: Partial<KnowledgeRecord> = {},
): KnowledgeRecord => ({
  id: 'pattern-1',
  tenantId: null,
  title: 'ชื่อแพตเทิร์น',
  description: null,
  category: null,
  intentKey: null,
  entityKey: null,
  topicKey: null,
  keywords: [],
  questionExamples: [],
  answer: 'คำตอบ',
  language: 'th',
  renderMode: 'DIRECT',
  priority: 0,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/** KnowledgeItem ที่ผ่านด่าน eligible() ของ KnowledgeRetrievalService */
export const makeItem = (
  overrides: Partial<KnowledgeItem> = {},
): KnowledgeItem => ({
  source: 'ANSWER_PATTERN',
  id: 'item-1',
  title: 'หัวข้อ',
  category: null,
  content: 'เนื้อหา',
  answer: 'คำตอบ',
  score: 5,
  renderMode: 'DIRECT',
  ...overrides,
  metadata: {
    tenantId: null,
    language: 'th',
    active: true,
    rawScore: 5,
    priority: 0,
    ...overrides.metadata,
  },
});

export const userMessage = (text: string): ChatContextMessage => ({
  role: 'user',
  text,
  source: 'USER',
  createdAt: 0,
});

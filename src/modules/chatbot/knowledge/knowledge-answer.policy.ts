import type { KnowledgeItem } from '../types/chat.types';

/** Archived/test snapshots cannot establish a current business fact. */
export function isUsableKnowledge(
  item: Pick<KnowledgeItem, 'title' | 'content' | 'answer'>,
): boolean {
  const text = [item.title, item.content, item.answer].join('\n');
  return !/\bsnapshot\b|ข้อมูลทดสอบ|ห้ามใช้[^\n]*(?:ปัจจุบัน|ยืนยัน)/iu.test(
    text,
  );
}

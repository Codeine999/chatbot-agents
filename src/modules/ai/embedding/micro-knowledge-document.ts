export type MicroKnowledgeDocumentInput = {
  title: string;
  description?: string | null;
  category?: string | null;
  intentKey?: string | null;
  entityKey?: string | null;
  topicKey?: string | null;
  keywords: string[];
  questionExamples: string[];
  answer: string;
};

/**
 * Builds the canonical embedding source for one independently composable fact.
 * Every writer must use this function so create, update and reindex keep the
 * same vector semantics.
 */
export function buildMicroKnowledgeDocument(
  input: MicroKnowledgeDocumentInput,
): string {
  return [
    `หัวข้อ: ${input.title}`,
    input.description ? `รายละเอียด: ${input.description}` : null,
    input.category ? `หมวดหมู่: ${input.category}` : null,
    input.intentKey ? `เจตนา: ${input.intentKey}` : null,
    input.entityKey ? `สิ่งที่อ้างถึง: ${input.entityKey}` : null,
    input.topicKey ? `ประเด็น: ${input.topicKey}` : null,
    input.keywords.length ? `คำสำคัญ: ${input.keywords.join(', ')}` : null,
    input.questionExamples.length
      ? `ตัวอย่างคำถาม:\n${input.questionExamples.join('\n')}`
      : null,
    `ข้อเท็จจริง: ${input.answer}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export type AnswerPatternDocumentInput = {
  title: string;
  description?: string | null;
  category?: string | null;
  intentKey?: string | null;
  keywords: string[];
  questionExamples: string[];
  answer: string;
};

/**
 * The text an `AnswerPattern` is embedded as.
 *
 * Shared rather than private to the admin service because every writer of a
 * vector must produce byte-identical input: a backfill that formatted the
 * same pattern differently would place it elsewhere in the vector space than
 * the one `create()` wrote, and the difference is invisible — retrieval would
 * simply rank it worse, with nothing to compare against.
 */
export function buildAnswerPatternDocument(
  input: AnswerPatternDocumentInput,
): string {
  return [
    `หัวข้อ: ${input.title}`,
    input.description ? `รายละเอียด: ${input.description}` : null,
    input.category ? `หมวดหมู่: ${input.category}` : null,
    input.intentKey ? `เจตนา: ${input.intentKey}` : null,
    input.keywords.length ? `คำสำคัญ: ${input.keywords.join(', ')}` : null,
    input.questionExamples.length
      ? `ตัวอย่างคำถาม:\n${input.questionExamples.join('\n')}`
      : null,
    `คำตอบ: ${input.answer}`,
  ]
    .filter(Boolean)
    .join('\n');
}

import { ChatIntent } from '../types/chat.types';

export function classifierPrompt(
  input: string,
  validIntents: ChatIntent[],
): string {
  return `
Classify this customer message. Return JSON only, no markdown.

Message: "${input.replace(/"/g, "'")}"

Valid intents: ${validIntents.join(', ')}

Rules:
- "สมัคร" alone = REGISTER high confidence
- "สมัครยังไง"/"วิธีสมัคร"/"เปิดยูสยังไง" = REGISTER_HOW_TO
- Casual chat, identity, greeting, or normal conversation such as "คุณคือใคร", "ทำอะไรอยู่", "ว่าไง", "เป็นไงบ้าง", "งง ai ปะ" = GENERAL_QUESTION
- General messages that do not need DB lookup = GENERAL_QUESTION
- Questions that should be answered from DB/knowledge base, such as "สมัครยังไง", "วิธีสมัคร", "เปิดยูสยังไง" = ANSWER_KNOWLEDGE
- Distinguish "I want to register" vs "How do I register?"
- Do not answer the customer. Only classify intent.

Return:
{"intent":"...","confidence":0.0}}`;
}
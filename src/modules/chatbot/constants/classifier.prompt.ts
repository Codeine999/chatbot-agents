import { ChatIntent } from '../types/chat.types';

export function classifierPrompt(
  input: string,
  validIntents: ChatIntent[],
): string {
  return `
Classify only the latest customer message and rewrite it as a standalone query.
Return JSON only, no markdown.

Latest customer message: ${JSON.stringify(input)}

Valid intents: ${validIntents.join(', ')}

Rules:
- "สมัคร" alone = REGISTER high confidence
- "สมัครยังไง"/"วิธีสมัคร"/"เปิดยูสยังไง" = REGISTER_HOW_TO
- Casual chat, identity, greeting, or normal conversation such as "คุณคือใคร", "ทำอะไรอยู่", "ว่าไง", "เป็นไงบ้าง", "งง ai ปะ" = GENERAL_QUESTION
- General messages that do not need DB lookup = GENERAL_QUESTION
- Questions about shop information, products, price, delivery, promotions, policies, or other facts that should be answered from the database = ANSWER_KNOWLEDGE
- Distinguish "I want to register" vs "How do I register?"
- Use the preceding conversation only to resolve references such as "อันนั้น", "ตัวนี้", "แล้วล่ะ", or "เมื่อกี้".
- standaloneQuery must contain the latest message rewritten so it can be searched without conversation history.
- Do not add facts that are absent from the latest message or conversation history.
- If the latest message is already complete, keep it unchanged in standaloneQuery.
- If a reference cannot be resolved, keep the latest message unchanged and lower confidence.
- Do not answer the customer. Only classify intent.

Return:
{"intent":"...","confidence":0.0,"standaloneQuery":"..."}`;
}

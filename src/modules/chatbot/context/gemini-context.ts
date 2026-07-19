import type { Content } from '@google/genai';
import { ChatContextMessage } from '../types/chat.types';

const MAX_RECENT_CONTEXT_CHARACTERS = 6_000;

/** Converts validated chat context to Gemini roles and appends current input. */
export function toGeminiContents(
  recentMessages: readonly ChatContextMessage[],
  currentInput: string,
): Content[] {
  const selectedMessages = selectNewestMessagesWithinBudget(recentMessages);
  const contents: Content[] = selectedMessages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.text }],
  }));

  contents.push({
    role: 'user',
    parts: [{ text: currentInput }],
  });

  return contents;
}

function selectNewestMessagesWithinBudget(
  messages: readonly ChatContextMessage[],
): readonly ChatContextMessage[] {
  const selected: ChatContextMessage[] = [];
  let usedCharacters = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;

    if (
      selected.length >= 6 ||
      usedCharacters + message.text.length > MAX_RECENT_CONTEXT_CHARACTERS
    ) {
      break;
    }

    selected.unshift(message);
    usedCharacters += message.text.length;
  }

  // A model turn without its preceding user turn is misleading context.
  while (selected[0]?.role === 'assistant') {
    selected.shift();
  }

  return selected;
}

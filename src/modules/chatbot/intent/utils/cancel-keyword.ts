/** Whole-message words that exit any active flow. */
export const CANCEL_KEYWORDS: readonly string[] = ['ยกเลิก', 'cancel', 'ออก'];

export const isCancelKeyword = (text: string): boolean =>
  CANCEL_KEYWORDS.includes(text.trim().toLowerCase());

import { catalogLexicon } from '../../search/catalog-fields';
import { matchesWholeMessage } from '../../business/lexicon-match';
import type { BusinessLexicon } from '../../attributes/types/attribute-definition.types';

/**
 * Short store-policy questions asked as the whole message, e.g. "ส่งฟรีไหม".
 * These keep the legacy cache/DIRECT route and never reach the Product planner.
 * Whitespace is ignored and a trailing polite particle or question mark is
 * allowed. The patterns belong to the business lexicon (default ECOMMERCE).
 */
export function isStandalonePolicyQuestion(
  message: string,
  lexicon: BusinessLexicon = catalogLexicon(null),
): boolean {
  return matchesWholeMessage(lexicon.standalonePolicyQuestions, message);
}

import { businessPromptRules } from '../../../../../products/search/catalog-fields';
import {
  GENERAL_PRODUCT_PLANNER_RULES,
  GENERAL_PRODUCT_ANSWER_RULES,
} from './general-product-prompt';

/** Business wording comes from the selected preset; GENERAL rules otherwise. */
export function businessPrompt(
  type: string | null | undefined,
  purpose: 'planner' | 'answer',
): string {
  return (
    businessPromptRules(type, purpose) ??
    (purpose === 'planner'
      ? GENERAL_PRODUCT_PLANNER_RULES
      : GENERAL_PRODUCT_ANSWER_RULES)
  );
}

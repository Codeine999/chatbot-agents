import { FASHION_PLANNER_RULES, FASHION_ANSWER_RULES } from './fashion-prompt';
import {
  RESTAURANT_PLANNER_RULES,
  RESTAURANT_ANSWER_RULES,
} from './restaurant-prompt';
import { HOTEL_PLANNER_RULES, HOTEL_ANSWER_RULES } from './hotel-prompt';
import {
  GENERAL_PRODUCT_PLANNER_RULES,
  GENERAL_PRODUCT_ANSWER_RULES,
} from './general-product-prompt';

const prompts: Record<string, { planner: string; answer: string }> = {
  FASHION: { planner: FASHION_PLANNER_RULES, answer: FASHION_ANSWER_RULES },
  RESTAURANT: {
    planner: RESTAURANT_PLANNER_RULES,
    answer: RESTAURANT_ANSWER_RULES,
  },
  HOTEL: { planner: HOTEL_PLANNER_RULES, answer: HOTEL_ANSWER_RULES },
};

export function businessPrompt(
  type: string | null | undefined,
  purpose: 'planner' | 'answer',
): string {
  return (
    prompts[type ?? '']?.[purpose] ??
    (purpose === 'planner'
      ? GENERAL_PRODUCT_PLANNER_RULES
      : GENERAL_PRODUCT_ANSWER_RULES)
  );
}

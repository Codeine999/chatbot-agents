import type { ProductPlan } from './product-search.types';

/** Constraints that select catalog rows on their own, without a named subject. */
export function hasCatalogConstraints(plan: ProductPlan): boolean {
  return (
    plan.options.length > 0 ||
    plan.filters.length > 0 ||
    plan.category !== null ||
    plan.minPrice !== null ||
    plan.maxPrice !== null ||
    plan.inStockOnly
  );
}

/** Stock-only filtering must be grounded in the customer's words, not inferred by the planner. */
export function groundStockFilter(
  plan: ProductPlan,
  message: string,
): ProductPlan {
  const explicit = /พร้อมส่ง|มี(?:ของ|สต็อก|สต๊อก)|ที่เหลือ|in\s*stock/iu.test(
    message,
  );
  const declined =
    /(?:ไม่ต้อง|ไม่จำเป็น|ไม่สนใจ|ไม่ต้องการ).{0,16}(?:สต็อก|สต๊อก|stock|พร้อมส่ง)/iu.test(
      message,
    );
  return {
    ...plan,
    // "สีดำ L มีของไหม" asks for one variant's stock: report it, never filter
    // it away and turn "out of stock" into "which product?".
    inStockOnly:
      plan.inStockOnly && explicit && !declined && plan.operation !== 'DETAIL',
    stockQuantitySource:
      /(?:ในคลัง|ในโกดัง|on\s*hand|onhand|physical stock)/iu.test(message)
        ? 'ON_HAND'
        : 'AVAILABLE',
  };
}

/**
 * askFields may only name fields the store lets the model see. A key that is
 * not (invented, hidden, repeated) is dropped on its own; the plan stays.
 */
export function groundAskFields(
  plan: ProductPlan,
  askable: readonly { key: string }[],
): ProductPlan {
  if (!plan.askFields) return plan;
  const allowed = new Set(askable.map((f) => f.key));
  return {
    ...plan,
    askFields: [...new Set(plan.askFields.filter((key) => allowed.has(key)))],
  };
}

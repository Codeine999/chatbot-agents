import type { ProductPlan } from './product-search.types';

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
    inStockOnly: plan.inStockOnly && explicit && !declined,
    stockQuantitySource:
      /(?:ในคลัง|ในโกดัง|on\s*hand|onhand|physical stock)/iu.test(message)
        ? 'ON_HAND'
        : 'AVAILABLE',
  };
}

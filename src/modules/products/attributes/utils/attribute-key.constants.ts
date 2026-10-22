/** Field keys stored in meta: lowercase, digits and _, starting with a letter. */
export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** Core catalog columns; a custom field must never shadow them. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'code',
  'sku',
  'description',
  'details',
  'category',
  'aliases',
  'language',
  'status',
  'price',
  'base_price',
  'price_override',
  'effective_price',
  'currency',
  'stock',
  'inventory',
  'track_stock',
  'company_id',
  'tenant_id',
]);

/**
 * Money, stock and personal data have authoritative columns or must never be
 * stored on a product, so they cannot become free-form fields either.
 */
export const SENSITIVE_KEY_WORDS: ReadonlySet<string> = new Set([
  'price',
  'cost',
  'stock',
  'qty',
  'quantity',
  'inventory',
  'onhand',
  'password',
  'bank',
  'account',
  'phone',
  'tel',
  'mobile',
  'email',
  'address',
  'citizen',
  'passport',
  'tax',
]);

/** The same words in a field label, Thai or English. */
export const SENSITIVE_LABEL =
  /(ราคา|ต้นทุน|กำไร|สต็อก|สต๊อก|คงเหลือ|เบอร์|โทร|อีเมล|บัญชี|ที่อยู่|บัตรประชาชน|รหัสผ่าน|\bprice\b|\bcost\b|\bstock\b|\bphone\b|\bemail\b|\baddress\b|\bpassword\b)/iu;

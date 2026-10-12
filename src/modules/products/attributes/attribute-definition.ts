import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { normalizeText, redactPii } from '../../../utils/text.utils';

export const ATTRIBUTE_SCOPES = ['PRODUCT', 'VARIANT'] as const;
export const ATTRIBUTE_TYPES = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'SELECT',
  'MULTI_SELECT',
  'TAGS',
] as const;
export type AttributeScope = (typeof ATTRIBUTE_SCOPES)[number];
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** The subset of a stored definition that validation, search and answers need. */
export type AttributeDefinition = Readonly<{
  key: string;
  label: string;
  scope: AttributeScope;
  type: AttributeType;
  options: readonly string[];
  valueAliases: Readonly<Record<string, readonly string[]>>;
  unit: string | null;
  required: boolean;
  variantOption: boolean;
  searchable: boolean;
  aiVisible: boolean;
  categories: readonly string[];
  sortOrder: number;
  status: 'ACTIVE' | 'ARCHIVED';
}>;

export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** Core catalog columns; a custom field must never shadow them. */
const RESERVED_KEYS = new Set([
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
// Money, stock and personal data have authoritative columns or must never be
// stored on a product, so they cannot become free-form fields either.
const SENSITIVE_KEY_WORDS = new Set([
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
const SENSITIVE_LABEL =
  /(ราคา|ต้นทุน|กำไร|สต็อก|สต๊อก|คงเหลือ|เบอร์|โทร|อีเมล|บัญชี|ที่อยู่|บัตรประชาชน|รหัสผ่าน|\bprice\b|\bcost\b|\bstock\b|\bphone\b|\bemail\b|\baddress\b|\bpassword\b)/iu;

/** False for built-in column names and money/stock/personal-data words. */
export function isSafeAttributeKey(key: string): boolean {
  return (
    ATTRIBUTE_KEY_PATTERN.test(key) &&
    !RESERVED_KEYS.has(key) &&
    !key.split('_').some((word) => SENSITIVE_KEY_WORDS.has(word))
  );
}

/** Rejects keys/labels that would turn a custom field into a money, stock or PII column. */
export function assertSafeDefinition(key: string, label: string): void {
  if (!ATTRIBUTE_KEY_PATTERN.test(key))
    throw new BadRequestException(
      'Field key must be lowercase letters, digits or _ and start with a letter',
    );
  if (RESERVED_KEYS.has(key))
    throw new BadRequestException(`"${key}" is a built-in product field`);
  if (key.split('_').some((word) => SENSITIVE_KEY_WORDS.has(word)))
    throw new BadRequestException(
      'Price, stock and personal data cannot be custom fields',
    );
  if (SENSITIVE_LABEL.test(label))
    throw new BadRequestException(
      'Price, stock and personal data cannot be custom fields',
    );
}

/** Shape-only check at the HTTP edge; definitions are enforced in the service. */
export const attributeValueSchema = z.union([
  z.string().trim().min(1).max(500),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().trim().min(1).max(100)).max(30),
]);
export const attributeValuesSchema = z
  .record(
    z
      .string()
      .regex(ATTRIBUTE_KEY_PATTERN)
      .refine(isSafeAttributeKey, 'Not a custom field key'),
    attributeValueSchema,
  )
  .refine((value) => Object.keys(value).length <= 50, 'At most 50 fields');
export type AttributeValues = z.infer<typeof attributeValuesSchema>;

export function appliesToCategory(
  definition: Pick<AttributeDefinition, 'categories'>,
  category: string | null | undefined,
): boolean {
  if (!definition.categories.length) return true;
  const wanted = normalizeText(category ?? '');
  return (
    wanted.length > 0 &&
    definition.categories.some((c) => normalizeText(c) === wanted)
  );
}

/**
 * Validates one product's or variant's field values against the store's
 * definitions. Archived values already stored are preserved untouched; the
 * caller sends only active fields.
 */
export function validateAttributeValues(params: {
  definitions: readonly AttributeDefinition[];
  scope: AttributeScope;
  category: string | null | undefined;
  values: Record<string, unknown>;
  stored?: Record<string, unknown>;
  enforceRequired: boolean;
}): Record<string, unknown> {
  const { definitions, scope, category, values, stored = {} } = params;
  const byKey = new Map(
    definitions.filter((d) => d.scope === scope).map((d) => [d.key, d]),
  );
  const errors: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!byKey.has(key) || byKey.get(key)?.status === 'ARCHIVED')
      result[key] = value;
  }
  for (const [key, raw] of Object.entries(values)) {
    const definition = byKey.get(key);
    if (!definition) {
      errors.push(`${key}: no such ${scope.toLowerCase()} field`);
      continue;
    }
    if (definition.status !== 'ACTIVE') {
      errors.push(`${key}: field is archived`);
      continue;
    }
    if (!appliesToCategory(definition, category)) {
      errors.push(`${key}: not used for category "${category ?? ''}"`);
      continue;
    }
    const checked = checkValue(definition, raw);
    if (typeof checked === 'string') errors.push(`${key}: ${checked}`);
    else result[key] = checked.value;
  }
  if (params.enforceRequired)
    for (const definition of byKey.values())
      if (
        definition.required &&
        definition.status === 'ACTIVE' &&
        appliesToCategory(definition, category) &&
        result[definition.key] === undefined
      )
        errors.push(`${definition.key}: required`);
  if (errors.length)
    throw new BadRequestException({
      message: 'Invalid product fields',
      errors,
    });
  return result;
}

function checkValue(
  definition: AttributeDefinition,
  raw: unknown,
): { value: unknown } | string {
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() && value.trim().length <= max
      ? value.trim()
      : undefined;
  const containsPii = (value: string) => redactPii(value) !== value.trim();
  switch (definition.type) {
    case 'TEXT': {
      const value = text(raw, 500);
      if (!value) return 'expected text';
      return containsPii(value) ? 'must not contain personal data' : { value };
    }
    case 'NUMBER':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? { value: raw }
        : 'expected a number';
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? { value: raw } : 'expected true/false';
    case 'SELECT': {
      const value = text(raw, 100);
      return value && definition.options.includes(value)
        ? { value }
        : `expected one of: ${definition.options.join(', ')}`;
    }
    case 'MULTI_SELECT':
    case 'TAGS': {
      if (!Array.isArray(raw) || raw.length > 30) return 'expected a list';
      const values = raw.map((v) => text(v, 100));
      if (values.some((v) => !v)) return 'expected a list of text';
      const list = [...new Set(values as string[])];
      if (
        definition.type === 'MULTI_SELECT' &&
        list.some((v) => !definition.options.includes(v))
      )
        return `expected values from: ${definition.options.join(', ')}`;
      return list.some(containsPii)
        ? 'must not contain personal data'
        : { value: list };
    }
  }
}

/** Customer-facing text for a stored value: lists joined, booleans in Thai, units appended. */
export function formatAttributeValue(
  definition: Pick<AttributeDefinition, 'type' | 'unit'>,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value))
    return value.length ? value.map(String).join(', ') : undefined;
  if (typeof value === 'boolean') return value ? 'มี' : 'ไม่มี';
  if (typeof value === 'number')
    return definition.unit ? `${value} ${definition.unit}` : String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

// Customers often prefix the choice with its kind ("สีดำ", "ไซส์ M", "รสช็อกโกแลต").
const GENERIC_OPTION_PREFIXES = [
  'สี',
  'ไซส์',
  'ไซซ์',
  'ไซด์',
  'ขนาด',
  'เบอร์',
  'รสชาติ',
  'รส',
  'ความจุ',
  'size',
  'color',
  'colour',
];

/**
 * Compares a customer's wording with stored option values: label/kind
 * prefixes, spacing, case, the unit and store-defined aliases are ignored.
 */
export function optionMatcher(
  definition: Pick<AttributeDefinition, 'label' | 'unit' | 'valueAliases'>,
) {
  const prefixes = [
    ...new Set([normalizeText(definition.label), ...GENERIC_OPTION_PREFIXES]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const unit = normalizeText(definition.unit ?? '').replace(/\s+/gu, '');
  const base = (value: string) => {
    let text = normalizeText(value);
    for (const prefix of prefixes)
      if (text.startsWith(prefix) && text.length > prefix.length) {
        text = text.slice(prefix.length);
        break;
      }
    text = text.replace(/\s+/gu, '');
    return unit && text.endsWith(unit) && text.length > unit.length
      ? text.slice(0, -unit.length)
      : text;
  };
  const canonical = new Map<string, string>();
  for (const [stored, aliases] of Object.entries(definition.valueAliases))
    for (const alias of [stored, ...aliases])
      canonical.set(base(alias), base(stored));
  const key = (value: string) => canonical.get(base(value)) ?? base(value);
  return {
    key,
    matches: (stored: unknown, asked: string) =>
      typeof stored === 'string' && key(stored) === key(asked),
  };
}

/** Editable definition fields; key, scope and type are fixed after creation. */
export const attributeDefinitionFields = z
  .object({
    key: z.string().regex(ATTRIBUTE_KEY_PATTERN),
    label: z.string().trim().min(1).max(100),
    scope: z.enum(ATTRIBUTE_SCOPES),
    type: z.enum(ATTRIBUTE_TYPES),
    options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    valueAliases: z
      .record(
        z.string().trim().min(1).max(100),
        z.array(z.string().trim().min(1).max(100)).max(20),
      )
      .refine((v) => Object.keys(v).length <= 200, 'At most 200 aliased values')
      .default({}),
    unit: z.string().trim().min(1).max(20).nullable().default(null),
    required: z.boolean().default(false),
    variantOption: z.boolean().default(false),
    searchable: z.boolean().default(true),
    aiVisible: z.boolean().default(true),
    categories: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    sortOrder: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

/** Cross-field rules shared by create, update (on the merged result) and presets. */
export function definitionIssues(
  d: Pick<AttributeDefinition, 'scope' | 'type' | 'options' | 'variantOption'>,
): string[] {
  const issues: string[] = [];
  if (d.variantOption && d.scope !== 'VARIANT')
    issues.push('Only variant fields can be customer choices');
  const selectable = d.type === 'SELECT' || d.type === 'MULTI_SELECT';
  if (selectable && !d.options.length)
    issues.push('Select fields need options');
  if (!selectable && d.options.length)
    issues.push('Only select fields have options');
  return issues;
}
export const attributeDefinitionSchema = attributeDefinitionFields.superRefine(
  (d, context) => {
    for (const message of definitionIssues(d))
      context.addIssue({ code: 'custom', message });
  },
);
export type AttributeDefinitionInput = z.input<
  typeof attributeDefinitionSchema
>;

const COLOR_ALIASES = {
  ดำ: ['black', 'สีดำ'],
  ขาว: ['white', 'สีขาว'],
  แดง: ['red', 'สีแดง'],
  เขียว: ['green', 'สีเขียว'],
  เหลือง: ['yellow', 'สีเหลือง'],
  ชมพู: ['pink', 'สีชมพู'],
  เทา: ['gray', 'grey', 'สีเทา'],
  น้ำตาล: ['brown', 'สีน้ำตาล'],
  ส้ม: ['orange', 'สีส้ม'],
  ม่วง: ['purple', 'สีม่วง'],
  ครีม: ['cream', 'สีครีม'],
  เบจ: ['beige', 'สีเบจ'],
};
const brand: AttributeDefinitionInput = {
  key: 'brand',
  label: 'แบรนด์',
  scope: 'VARIANT',
  type: 'TEXT',
  sortOrder: 1,
};
const tags: AttributeDefinitionInput = {
  key: 'tags',
  label: 'แท็ก',
  scope: 'VARIANT',
  type: 'TAGS',
  sortOrder: 2,
};
const color: AttributeDefinitionInput = {
  key: 'color',
  label: 'สี',
  scope: 'VARIANT',
  type: 'TEXT',
  variantOption: true,
  valueAliases: COLOR_ALIASES,
  sortOrder: 10,
};

/** Built-in fields every product has; presets only describe them for the form. */
export const CORE_PRODUCT_FIELDS = [
  { key: 'name', label: 'ชื่อสินค้า', level: 'PRODUCT' },
  { key: 'description', label: 'รายละเอียด', level: 'PRODUCT' },
  { key: 'category', label: 'หมวดหมู่', level: 'PRODUCT' },
  { key: 'sku', label: 'SKU', level: 'VARIANT' },
  { key: 'price', label: 'ราคา', level: 'VARIANT' },
  { key: 'compareAtPrice', label: 'ราคาเดิม', level: 'VARIANT' },
  { key: 'trackStock', label: 'ติดตามสต็อก', level: 'VARIANT' },
  { key: 'stock', label: 'สต็อก', level: 'VARIANT' },
] as const;

/** Code-defined fields selected for a business; values belong to its variants. */
export const BUSINESS_PRESETS: Readonly<
  Record<string, { label: string; fields: readonly AttributeDefinitionInput[] }>
> = {
  FASHION: {
    label: 'แฟชั่น / เสื้อผ้า',
    fields: [
      brand,
      tags,
      {
        key: 'material',
        label: 'เนื้อผ้า',
        scope: 'VARIANT',
        type: 'TEXT',
        sortOrder: 3,
      },
      color,
      {
        key: 'condition',
        label: 'สภาพสินค้า',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 12,
      },
      {
        key: 'size',
        label: 'ไซส์',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        valueAliases: { 'Free Size': ['ฟรีไซส์', 'ฟรีไซซ์', 'freesize'] },
        sortOrder: 11,
      },
    ],
  },
  ELECTRONICS: {
    label: 'อิเล็กทรอนิกส์ / มือถือ',
    fields: [
      brand,
      tags,
      {
        key: 'warranty',
        label: 'การรับประกัน',
        scope: 'VARIANT',
        type: 'TEXT',
        sortOrder: 3,
      },
      color,
      {
        key: 'storage',
        label: 'ความจุ',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 11,
      },
    ],
  },
  FOOD: {
    label: 'อาหาร / ขนม',
    fields: [
      brand,
      tags,
      {
        key: 'ingredients',
        label: 'ส่วนประกอบ',
        scope: 'VARIANT',
        type: 'TEXT',
        sortOrder: 3,
      },
      {
        key: 'allergens',
        label: 'สารก่อภูมิแพ้',
        scope: 'VARIANT',
        type: 'TAGS',
        sortOrder: 4,
      },
      {
        key: 'shelf_life',
        label: 'อายุการเก็บรักษา',
        scope: 'VARIANT',
        type: 'TEXT',
        sortOrder: 5,
      },
      {
        key: 'flavor',
        label: 'รสชาติ',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 10,
      },
      {
        key: 'net_weight',
        label: 'ขนาดบรรจุ',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 11,
      },
    ],
  },
  BEAUTY: {
    label: 'ความงาม / เครื่องสำอาง',
    fields: [
      brand,
      tags,
      {
        key: 'skin_type',
        label: 'สภาพผิวที่เหมาะ',
        scope: 'VARIANT',
        type: 'TAGS',
        sortOrder: 3,
      },
      {
        key: 'shade',
        label: 'เฉดสี',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 10,
      },
      {
        key: 'volume',
        label: 'ปริมาณ',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 11,
      },
    ],
  },
  RESTAURANT: {
    label: 'ร้านอาหาร',
    fields: [
      tags,
      {
        key: 'ingredients',
        label: 'ส่วนประกอบ',
        scope: 'VARIANT',
        type: 'TEXT',
        sortOrder: 3,
      },
      {
        key: 'allergens',
        label: 'สารก่อภูมิแพ้',
        scope: 'VARIANT',
        type: 'TAGS',
        sortOrder: 4,
      },
      {
        key: 'portion',
        label: 'ขนาดจาน',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 10,
      },
      {
        key: 'spice_level',
        label: 'ระดับความเผ็ด',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 11,
      },
    ],
  },
  HOTEL: {
    label: 'โรงแรม / ที่พัก',
    fields: [
      tags,
      {
        key: 'amenities',
        label: 'สิ่งอำนวยความสะดวก',
        scope: 'VARIANT',
        type: 'TAGS',
        sortOrder: 3,
      },
      {
        key: 'bed_type',
        label: 'ประเภทเตียง',
        scope: 'VARIANT',
        type: 'TEXT',
        variantOption: true,
        sortOrder: 10,
      },
      {
        key: 'max_guests',
        label: 'จำนวนผู้เข้าพักสูงสุด',
        scope: 'VARIANT',
        type: 'NUMBER',
        sortOrder: 11,
      },
      {
        key: 'room_area',
        label: 'พื้นที่ห้อง',
        scope: 'VARIANT',
        type: 'NUMBER',
        unit: 'ตร.ม.',
        sortOrder: 12,
      },
    ],
  },
  GENERAL: { label: 'ทั่วไป', fields: [brand, tags] },
};
export const BUSINESS_TYPES = Object.keys(BUSINESS_PRESETS);

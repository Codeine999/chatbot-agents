import type { AttributeDefinitionInput } from '../dto/attribute-definition.dto';

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

/** Business wording added to the product planner and answer prompts. */
export type BusinessPrompt = Readonly<{ planner: string; answer: string }>;

/** A selectable business: its meta fields and its prompt wording. */
export type BusinessPreset = Readonly<{
  label: string;
  prompt: BusinessPrompt;
  fields: readonly AttributeDefinitionInput[];
}>;

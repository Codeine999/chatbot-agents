import type { AttributeDefinitionInput } from '../dto/attribute-definition.dto';

/** Customer wording for stored colors; optionMatcher already strips the "สี" prefix. */
const COLOR_ALIASES = {
  ดำ: ['black'],
  ขาว: ['white'],
  แดง: ['red'],
  เขียว: ['green'],
  เหลือง: ['yellow'],
  ชมพู: ['pink'],
  เทา: ['gray', 'grey'],
  น้ำตาล: ['brown'],
  ส้ม: ['orange'],
  ม่วง: ['purple'],
  ครีม: ['cream'],
  เบจ: ['beige'],
};

export const brandField: AttributeDefinitionInput = {
  key: 'brand',
  label: 'แบรนด์',
  scope: 'VARIANT',
  type: 'TEXT',
  sortOrder: 1,
};

export const tagsField: AttributeDefinitionInput = {
  key: 'tags',
  label: 'แท็ก',
  scope: 'VARIANT',
  type: 'TAGS',
  sortOrder: 2,
};

export const colorField: AttributeDefinitionInput = {
  key: 'color',
  label: 'สี',
  scope: 'VARIANT',
  type: 'TEXT',
  variantOption: true,
  valueAliases: COLOR_ALIASES,
  sortOrder: 10,
};

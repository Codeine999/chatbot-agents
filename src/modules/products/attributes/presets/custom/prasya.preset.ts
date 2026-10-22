import type { BusinessPreset } from '../../types/attribute-definition.types';
import { ECOMMERCE_PROMPT } from '../../prompts/ecommerce.prompt';
import { brandField, tagsField, colorField } from '../shared-fields';

export const ECOMMERCE_PRESET: BusinessPreset = {
  label: 'อีคอมเมิร์ซทั่วไป',
  prompt: ECOMMERCE_PROMPT,
  fields: [
    brandField,
    tagsField,
    {
      key: 'model',
      label: 'รุ่น',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 3,
    },
    colorField,
    {
      key: 'size',
      label: 'ขนาด / ไซส์',
      scope: 'VARIANT',
      type: 'TEXT',
      variantOption: true,
      sortOrder: 11,
    },
    {
      key: 'material',
      label: 'วัสดุ',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 20,
    },
    {
      key: 'weight_g',
      label: 'น้ำหนัก',
      scope: 'VARIANT',
      type: 'NUMBER',
      unit: 'g',
      sortOrder: 21,
    },
    {
      key: 'dimensions',
      label: 'ขนาดสินค้า (กว้าง x ยาว x สูง)',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 22,
    },
    {
      key: 'features',
      label: 'คุณสมบัติเด่น',
      scope: 'VARIANT',
      type: 'TAGS',
      sortOrder: 23,
    },
    {
      key: 'origin',
      label: 'แหล่งผลิต',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 24,
    },
    {
      key: 'warranty',
      label: 'การรับประกัน',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 25,
    },
    {
      key: 'package_contents',
      label: 'สิ่งที่ได้รับในกล่อง',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 26,
    },
  ],
};

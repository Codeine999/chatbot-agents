import type { BusinessPreset } from '../types/attribute-definition.types';
import { EDUCATION_PROMPT } from '../prompts/education.prompt';
import { EDUCATION_CAPABILITIES, EDUCATION_LEXICON } from './education.lexicon';

export const EDUCATION_PRESET: BusinessPreset = {
  label: 'การศึกษา/หลักสูตร',
  prompt: EDUCATION_PROMPT,
  capabilities: EDUCATION_CAPABILITIES,
  lexicon: EDUCATION_LEXICON,
  fields: [
    {
      key: 'degree',
      label: 'ระดับการศึกษา',
      scope: 'VARIANT',
      type: 'SELECT',
      variantOption: true,
      options: ['ป.ตรี', 'ป.โท', 'ป.เอก'],
      valueAliases: {
        'ป.ตรี': ['ปริญญาตรี', 'ตรี', 'bachelor'],
        'ป.โท': ['ปริญญาโท', 'โท', 'master'],
        'ป.เอก': ['ปริญญาเอก', 'เอก', 'doctorate', 'phd'],
      },
      sortOrder: 1,
    },
    {
      key: 'major',
      label: 'สาขาวิชา',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 2,
    },
    {
      key: 'place',
      label: 'สถานที่เรียน',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 3,
    },
    {
      key: 'requirement',
      label: 'คุณสมบัติผู้สมัคร',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 4,
    },
    {
      key: 'admission',
      label: 'วิธีรับเข้า',
      scope: 'VARIANT',
      type: 'TEXT',
      sortOrder: 5,
    },
    {
      key: 'scholarship',
      label: 'ทุนการศึกษา',
      scope: 'VARIANT',
      type: 'TAGS',
      sortOrder: 6,
    },
  ],
};

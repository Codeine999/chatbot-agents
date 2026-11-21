import type { BusinessPreset } from '../types/attribute-definition.types';
import { TRANSPORT_PROMPT } from '../prompts/transport.prompt';
import { TRANSPORT_CAPABILITIES, TRANSPORT_LEXICON } from './transport.lexicon';

/**
 * Customer wording for places. Used as the origin/destination aliases, so
 * "กทม", "bangkok" and "เอกมัย" all mean the stored "กรุงเทพฯ".
 */
const PLACE_ALIASES = {
  กรุงเทพฯ: [
    'กรุงเทพ',
    'กรุงเทพมหานคร',
    'กทม',
    'bangkok',
    'bkk',
    'เอกมัย',
    'หมอชิต',
    'สายใต้',
  ],
  พัทยา: ['pattaya'],
  ระยอง: ['rayong'],
  หัวหิน: ['hua hin', 'huahin'],
  ตราด: ['trat'],
  เกาะช้าง: ['koh chang', 'ko chang'],
};

export const TRANSPORT_PRESET: BusinessPreset = {
  label: 'ขนส่ง/รถโดยสาร',
  prompt: TRANSPORT_PROMPT,
  capabilities: TRANSPORT_CAPABILITIES,
  lexicon: TRANSPORT_LEXICON,
  fields: [
    {
      key: 'origin',
      label: 'ต้นทาง',
      scope: 'VARIANT',
      type: 'TEXT',
      valueAliases: PLACE_ALIASES,
      sortOrder: 1,
    },
    {
      key: 'destination',
      label: 'ปลายทาง',
      scope: 'VARIANT',
      type: 'TEXT',
      valueAliases: PLACE_ALIASES,
      sortOrder: 2,
    },
    {
      key: 'transfer_points',
      label: 'จุดต่อรถ',
      scope: 'VARIANT',
      type: 'TAGS',
      sortOrder: 3,
    },
    {
      key: 'is_regular_bus',
      label: 'รถประจำทาง',
      scope: 'VARIANT',
      type: 'BOOLEAN',
      sortOrder: 4,
    },
  ],
};

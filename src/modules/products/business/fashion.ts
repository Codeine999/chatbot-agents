import type { BusinessProfile } from './business-profile';

export const fashionProfile: BusinessProfile = {
  type: 'FASHION',
  relation: 'fashion',
  columns: { color: 'color', size: 'size', condition: 'condition' },
};

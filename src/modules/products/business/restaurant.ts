import type { BusinessProfile } from './business-profile';

export const restaurantProfile: BusinessProfile = {
  type: 'RESTAURANT',
  relation: 'restaurant',
  columns: { portion: 'portion', spice_level: 'spiceLevel' },
};

import { fashionProfile } from './fashion';
import { restaurantProfile } from './restaurant';
import { hotelProfile } from './hotel';
import type { BusinessProfile } from './business-profile';

export const physicalBusinessProfiles = [
  fashionProfile,
  restaurantProfile,
  hotelProfile,
] as const;

export function getBusinessProfile(type: string | null): BusinessProfile {
  return (
    physicalBusinessProfiles.find((profile) => profile.type === type) ?? {
      type: type ?? 'GENERAL',
      relation: null,
      columns: {},
    }
  );
}

export function businessIncludeFor(type: string | null) {
  const relation = getBusinessProfile(type).relation;
  return {
    fashion: relation === 'fashion',
    restaurant: relation === 'restaurant',
    hotel: relation === 'hotel',
  };
}

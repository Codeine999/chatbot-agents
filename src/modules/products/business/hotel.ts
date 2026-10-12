import type { BusinessProfile } from './business-profile';

export const hotelProfile: BusinessProfile = {
  type: 'HOTEL',
  relation: 'hotel',
  columns: {
    bed_type: 'bedType',
    max_guests: 'maxGuests',
    room_area: 'roomArea',
  },
};

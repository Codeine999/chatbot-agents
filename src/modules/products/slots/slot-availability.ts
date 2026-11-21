import type {
  AvailabilityState,
  BusinessCapabilities,
} from '../attributes/types/attribute-definition.types';

export type SlotSlotConfig = NonNullable<BusinessCapabilities['slot']>;
export const DEFAULT_SLOT_CONFIG: SlotSlotConfig = {
  horizonDays: 30,
  cutoffMinutes: 30,
  maxAgeMinutes: null,
};

export type SlotFacts = {
  startsAt: Date;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  capacity: number | null;
  reserved: number;
  availabilityAt: Date | null;
};

/**
 * Availability of one dated slot, decided by code and never by the model:
 *   CLOSED  - closed by an admin or inside the cutoff before it starts
 *   UNKNOWN - seat count not known, or confirmed longer ago than allowed
 *   FULL    - fewer seats left than the party needs (default 1)
 *   LOW     - enough seats, but at or below the low threshold
 *   AVAILABLE
 * seatsLeft is max(0, capacity - reserved) (overbooking never goes negative)
 * and null whenever it is not a trustworthy number.
 */
export function slotAvailability(
  slot: SlotFacts,
  now: Date,
  capabilities: Pick<BusinessCapabilities, 'lowThreshold'> & {
    slot?: SlotSlotConfig;
  },
  quantity: number | null,
): { state: AvailabilityState; seatsLeft: number | null } {
  const config = capabilities.slot ?? DEFAULT_SLOT_CONFIG;
  if (
    slot.status !== 'OPEN' ||
    slot.startsAt.getTime() < now.getTime() + config.cutoffMinutes * 60_000
  )
    return { state: 'CLOSED', seatsLeft: null };
  if (slot.capacity === null) return { state: 'UNKNOWN', seatsLeft: null };
  if (
    config.maxAgeMinutes !== null &&
    (!slot.availabilityAt ||
      now.getTime() - slot.availabilityAt.getTime() >
        config.maxAgeMinutes * 60_000)
  )
    return { state: 'UNKNOWN', seatsLeft: null };
  const left = Math.max(0, slot.capacity - slot.reserved);
  if (left < (quantity ?? 1)) return { state: 'FULL', seatsLeft: left };
  if (capabilities.lowThreshold !== null && left <= capabilities.lowThreshold)
    return { state: 'LOW', seatsLeft: left };
  return { state: 'AVAILABLE', seatsLeft: left };
}

/** A slot the customer could still take (UNKNOWN is shown, never claimed full). */
export const isOffer = (state: AvailabilityState) =>
  state === 'AVAILABLE' || state === 'LOW' || state === 'UNKNOWN';

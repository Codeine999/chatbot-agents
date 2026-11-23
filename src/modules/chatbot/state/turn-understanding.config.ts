import type { ConfigService } from '@nestjs/config';
import {
  DEFAULT_PHATIC_LIMITS,
  type PhaticLimits,
} from '../intent/utils/phatic-policy';

export type TurnUnderstandingConfig = Readonly<{
  /** `PHATIC_FAST_PATH_ENABLED`: bare acknowledgements skip retrieval and models. */
  phaticEnabled: boolean;
  /** `TURN_META_TTL_SEC`: how long a room's last-turn facts are kept. */
  turnMetaTtlSec: number;
  limits: PhaticLimits;
}>;

/** Everything off: the behaviour of a deployment that never set the flags. */
export const TURN_UNDERSTANDING_OFF: TurnUnderstandingConfig = {
  phaticEnabled: false,
  turnMetaTtlSec: 86400,
  limits: DEFAULT_PHATIC_LIMITS,
};

export function readTurnUnderstandingConfig(
  config: ConfigService,
): TurnUnderstandingConfig {
  return {
    phaticEnabled: booleanFlag(config, 'PHATIC_FAST_PATH_ENABLED'),
    turnMetaTtlSec: positiveInteger(
      config.get<unknown>('TURN_META_TTL_SEC'),
      TURN_UNDERSTANDING_OFF.turnMetaTtlSec,
    ),
    limits: {
      recentWindowSec: positiveInteger(
        config.get<unknown>('RECENT_WINDOW_SEC'),
        DEFAULT_PHATIC_LIMITS.recentWindowSec,
      ),
      adminActiveWindowSec: positiveInteger(
        config.get<unknown>('ADMIN_ACTIVE_WINDOW_SEC'),
        DEFAULT_PHATIC_LIMITS.adminActiveWindowSec,
      ),
      handoffPingCooldownSec: positiveInteger(
        config.get<unknown>('HANDOFF_PING_COOLDOWN_SEC'),
        DEFAULT_PHATIC_LIMITS.handoffPingCooldownSec,
      ),
      handoffWaitingMaxAgeSec: positiveInteger(
        config.get<unknown>('HANDOFF_WAITING_MAX_AGE_SEC'),
        DEFAULT_PHATIC_LIMITS.handoffWaitingMaxAgeSec,
      ),
    },
  };
}

/** Same strictness as CommerceFeatureService: a typo must not silently mean "off". */
function booleanFlag(config: ConfigService, key: string): boolean {
  const value = config.get<unknown>(key) ?? false;
  if (
    typeof value !== 'boolean' &&
    (typeof value !== 'string' || !/^(true|false)$/i.test(value.trim()))
  ) {
    throw new Error(`${key} must be true or false`);
  }
  return (
    value === true ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'true')
  );
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

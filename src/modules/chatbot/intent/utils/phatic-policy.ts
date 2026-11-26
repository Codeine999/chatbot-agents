import type { SmallTalkReply } from '../../../../shared/contracts/chat.types';
import type { TurnMeta } from '../../state/turn-meta.store';
import type { PhaticKind } from './phatic';

/** Windows in seconds; env-backed in TurnUnderstandingConfig, defaults here. */
export type PhaticLimits = Readonly<{
  /** A question the assistant asked stays "open" this long. */
  recentWindowSec: number;
  /** An admin who just wrote is still the one being answered. */
  adminActiveWindowSec: number;
  /** One "staff were told" notice per this long while waiting. */
  handoffPingCooldownSec: number;
  /** After this long a waiting room no longer proves staff are coming. */
  handoffWaitingMaxAgeSec: number;
}>;

export const DEFAULT_PHATIC_LIMITS: PhaticLimits = {
  recentWindowSec: 1800,
  adminActiveWindowSec: 1800,
  handoffPingCooldownSec: 900,
  handoffWaitingMaxAgeSec: 86400,
};

export type SmallTalkDecision = Readonly<{ reply: SmallTalkReply }>;

export type PhaticContext = Readonly<{
  meta: TurnMeta;
  /** The room is waiting for an admin. */
  handoffPending: boolean;
  /** Server clock, ms. Every stored time is server time too. */
  now: number;
  limits?: PhaticLimits;
}>;

const SILENT: SmallTalkDecision = { reply: 'SILENT' };

/**
 * What to do with a bare acknowledgement, given what happened before it.
 * Null means "not mine": the message answers something and takes the normal
 * route. The first row that applies wins.
 *
 * Code decides only where it is surer than a model: an admin's conversation,
 * a room waiting for staff, and a repeat of an acknowledgement. Everything
 * else goes to general chat, which reads the history (one call).
 */
export function decidePhatic(
  kind: PhaticKind,
  context: PhaticContext,
): SmallTalkDecision | null {
  const { meta, handoffPending, now } = context;
  const limits = context.limits ?? DEFAULT_PHATIC_LIMITS;
  const ageSec = (at: number) => (now - at) / 1000;
  const recent = (at: number | undefined) =>
    at !== undefined && ageSec(at) <= limits.recentWindowSec;

  // Waiting-queue nudges ("นานจังเลย รออยู่นะ") are fast-pathed ONLY when the
  // room is actually waiting for staff; open rooms route them normally.
  if (kind === 'WAITING_NUDGE') {
    if (!handoffPending) return null;
    if (
      meta.lastAdminAt !== undefined &&
      meta.lastAdminAt > (meta.lastActAt ?? 0) &&
      ageSec(meta.lastAdminAt) <= limits.adminActiveWindowSec
    ) {
      return SILENT;
    }
    if (meta.handoffNoticeAt !== undefined) {
      if (ageSec(meta.handoffNoticeAt) > limits.handoffWaitingMaxAgeSec) {
        return null;
      }
      if (ageSec(meta.handoffNoticeAt) <= limits.handoffPingCooldownSec) {
        return SILENT;
      }
    }
    return { reply: 'HANDOFF_WAITING_NUDGE' };
  }

  // 0. The assistant asked and is waiting: this is the answer, not small talk.
  if (meta.lastAct === 'ASKED' && recent(meta.lastActAt)) return null;

  // 1. An admin spoke last and recently: the message is for them.
  if (
    meta.lastAdminAt !== undefined &&
    meta.lastAdminAt > (meta.lastActAt ?? 0) &&
    ageSec(meta.lastAdminAt) <= limits.adminActiveWindowSec
  ) {
    return SILENT;
  }

  // 2. Never answer an acknowledgement of an acknowledgement, but only while
  //    it is recent: TurnMeta lives a day and a customer may come back.
  if (meta.lastAct === 'ACKED' && recent(meta.lastActAt)) return SILENT;

  // 3. Waiting for staff: say so once per cooldown, never invent progress.
  if (
    handoffPending &&
    meta.handoffNoticeAt !== undefined &&
    ageSec(meta.handoffNoticeAt) <= limits.handoffWaitingMaxAgeSec
  ) {
    return ageSec(meta.handoffNoticeAt) <= limits.handoffPingCooldownSec
      ? SILENT
      : { reply: 'HANDOFF_WAITING' };
  }

  // 4. Anything else: general chat answers it in context.
  return { reply: 'GENERAL' };
}

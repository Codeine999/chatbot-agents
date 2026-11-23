import type {
  AssistantAct,
  SmallTalkReply,
} from '../../../../shared/contracts/chat.types';
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

export type SmallTalkDecision = Readonly<{
  reply: SmallTalkReply;
  /** What to remember about this reply; none when nothing is sent. */
  act?: AssistantAct;
}>;

export type PhaticContext = Readonly<{
  meta: TurnMeta;
  /** The room is waiting for an admin. */
  handoffPending: boolean;
  /** Server clock, ms. Every stored time is server time too. */
  now: number;
  limits?: PhaticLimits;
}>;

const SILENT: SmallTalkDecision = { reply: 'SILENT' };

/** What a sent reply counts as in TurnMeta. Silence sends nothing, so nothing is kept. */
export function actOfSmallTalk(
  reply: SmallTalkReply,
): AssistantAct | undefined {
  switch (reply) {
    case 'ACK':
    case 'THANKS':
      return 'ACKED';
    case 'HANDOFF_WAITING':
      return 'HANDOFF_NOTICE';
    case 'SILENT':
      return undefined;
  }
}

/**
 * What to do with a bare acknowledgement, given what happened before it.
 * Null means "not mine": the message answers something and takes the normal
 * route. The first row that applies wins.
 *
 * A reply here is never a greeting and never carries content; staying silent
 * is only ever chosen for a message that had none.
 */
export function decidePhatic(
  kind: PhaticKind,
  context: PhaticContext,
): SmallTalkDecision | null {
  const { meta, handoffPending, now } = context;
  const limits = context.limits ?? DEFAULT_PHATIC_LIMITS;
  const ageSec = (at: number) => (now - at) / 1000;

  // 0. The assistant asked and is waiting: this is the answer, not small talk.
  if (
    meta.lastAct === 'ASKED' &&
    meta.lastActAt !== undefined &&
    ageSec(meta.lastActAt) <= limits.recentWindowSec
  ) {
    return null;
  }

  // 1. An admin spoke last and recently: the message is for them.
  if (
    meta.lastAdminAt !== undefined &&
    meta.lastAdminAt > (meta.lastActAt ?? 0) &&
    ageSec(meta.lastAdminAt) <= limits.adminActiveWindowSec
  ) {
    return SILENT;
  }

  // 2. Never answer an acknowledgement of an acknowledgement.
  if (meta.lastAct === 'ACKED') return SILENT;

  const closing = kind === 'THANKS' || kind === 'CLOSING';

  // 3. Waiting for staff: say so once per cooldown, never invent progress.
  if (
    handoffPending &&
    meta.handoffNoticeAt !== undefined &&
    ageSec(meta.handoffNoticeAt) <= limits.handoffWaitingMaxAgeSec
  ) {
    if (closing) return reply('THANKS');
    if (ageSec(meta.handoffNoticeAt) <= limits.handoffPingCooldownSec) {
      return SILENT;
    }
    return reply('HANDOFF_WAITING');
  }

  // 4. Just answered, long idle, or a waiting room too old to vouch for.
  return reply(closing ? 'THANKS' : 'ACK');
}

function reply(kind: Exclude<SmallTalkReply, 'SILENT'>): SmallTalkDecision {
  return { reply: kind, act: actOfSmallTalk(kind) };
}

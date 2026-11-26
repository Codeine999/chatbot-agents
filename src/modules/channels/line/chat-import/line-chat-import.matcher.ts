import { createHash } from 'node:crypto';
import type { StagedMessage } from './csv/line-chat-csv.mapper';

/**
 * Pure decisions of the import: which customer a thread belongs to, and which
 * staged messages to write next to the room's LIVE history.
 */

export type MatchDecision =
  | Readonly<{ threadId: string; status: 'MATCHED'; lineMemberId: string }>
  | Readonly<{ threadId: string; status: 'UNMATCHED' }>
  | Readonly<{ threadId: string; status: 'AMBIGUOUS' }>;

/**
 * Exact normalized-name match, never a guess: a thread is linked only when
 * exactly one member has its name, that member is not already linked to
 * another thread (`taken`), and no other thread of the batch points at the
 * same member. Everything else waits for the customer or an admin.
 */
export function matchThreads(
  threads: ReadonlyArray<Readonly<{ id: string; normalizedName: string }>>,
  membersByName: ReadonlyMap<string, readonly string[]>,
  taken: ReadonlySet<string> = new Set(),
): MatchDecision[] {
  const candidate = new Map<string, string | null>();
  const claims = new Map<string, number>();

  for (const thread of threads) {
    const members = membersByName.get(thread.normalizedName) ?? [];
    if (members.length === 1 && !taken.has(members[0])) {
      candidate.set(thread.id, members[0]);
      claims.set(members[0], (claims.get(members[0]) ?? 0) + 1);
    } else {
      candidate.set(thread.id, members.length === 0 ? null : '');
    }
  }

  return threads.map((thread): MatchDecision => {
    const member = candidate.get(thread.id);
    if (member === null) return { threadId: thread.id, status: 'UNMATCHED' };
    if (!member || (claims.get(member) ?? 0) > 1) {
      return { threadId: thread.id, status: 'AMBIGUOUS' };
    }
    return { threadId: thread.id, status: 'MATCHED', lineMemberId: member };
  });
}

/** Key of one imported row: unique per customer and message content. */
export function importKeyOf(lineMemberId: string, hash: string): string {
  return createHash('sha256')
    .update(`${lineMemberId}\u0000${hash}`)
    .digest('hex')
    .slice(0, 32);
}

export type OverlapMode = 'dedupe' | 'skipAfterFirstLive';

export type LiveRow = Readonly<{
  /** Prisma `LineChatSender` value. */
  sender: 'USER' | 'ADMIN' | 'AI' | 'SYSTEM';
  text: string | null;
  createdAt: Date;
}>;

export type ImportPlan = Readonly<{
  toWrite: StagedMessage[];
  skippedOverlap: number;
}>;

/** How far apart a LIVE row and an imported one may be and still be the same message. */
export const OVERLAP_TOLERANCE_MS = 60_000;

/**
 * The backup may cover days the webhook already recorded. Before the first
 * LIVE row every staged message is written. From one minute before it, a
 * staged message is dropped when a LIVE row of the same side with the same
 * text lies within a minute of it.
 *
 * Not everything after the first LIVE row is dropped (unless the mode asks):
 * replies typed in the LINE OA app after the connection never reach the
 * webhook, so the backup is the only place they exist.
 */
export function planImportRows(
  staged: readonly StagedMessage[],
  live: readonly LiveRow[],
  mode: OverlapMode = 'dedupe',
): ImportPlan {
  if (live.length === 0) return { toWrite: [...staged], skippedOverlap: 0 };

  const firstLiveMs = Math.min(...live.map((row) => row.createdAt.getTime()));
  const windowStart = firstLiveMs - OVERLAP_TOLERANCE_MS;
  const used = new Set<number>();
  const toWrite: StagedMessage[] = [];
  let skippedOverlap = 0;

  for (const message of staged) {
    const at = Date.parse(message.t);
    if (at < windowStart) {
      toWrite.push(message);
      continue;
    }
    if (mode === 'skipAfterFirstLive') {
      skippedOverlap += 1;
      continue;
    }

    const twin = live.findIndex(
      (row, index) =>
        !used.has(index) &&
        sideOf(row.sender) === message.s &&
        (row.text ?? '').trim() === message.x.trim() &&
        Math.abs(row.createdAt.getTime() - at) <= OVERLAP_TOLERANCE_MS,
    );
    if (twin >= 0) {
      used.add(twin);
      skippedOverlap += 1;
    } else {
      toWrite.push(message);
    }
  }

  return { toWrite, skippedOverlap };
}

function sideOf(sender: LiveRow['sender']): 'U' | 'A' {
  return sender === 'USER' ? 'U' : 'A';
}

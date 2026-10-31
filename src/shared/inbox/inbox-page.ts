import { BadRequestException } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const blankToUndefined = (value: unknown) =>
  value === null || value === '' ? undefined : value;

export const INBOX_DEFAULT_PAGE_SIZE = 30;

/**
 * Room-list query shared by the LINE and App inboxes. Sending any of these
 * switches the endpoint to the paged `{ items, nextCursor }` response; with
 * none, it keeps returning the legacy array until the dashboard migrates.
 */
export const listInboxConversationsQuerySchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    limit: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(100).optional(),
    ),
    cursor: z.preprocess(blankToUndefined, z.string().max(300).optional()),
    status: z.preprocess(
      blankToUndefined,
      z.enum(['waiting_admin', 'open']).optional(),
    ),
    unread: z.preprocess(
      (value) =>
        value === 'true'
          ? true
          : value === 'false'
            ? false
            : blankToUndefined(value),
      z.boolean().optional(),
    ),
    q: z.preprocess(
      blankToUndefined,
      z.string().trim().min(1).max(100).optional(),
    ),
  }),
);

export class ListInboxConversationsQueryDto extends createZodDto(
  listInboxConversationsQuerySchema,
) {}

export type ListInboxConversationsQuery = z.infer<
  typeof listInboxConversationsQuerySchema
>;

export const isPagedInboxQuery = (query: ListInboxConversationsQuery) =>
  Object.values(query).some((value) => value !== undefined);

/** Position after the last room returned; `after` absent = start of the group. */
type InboxCursor = Readonly<{
  waiting: boolean;
  after?: Readonly<{ lastMessageAt: Date; id: string }>;
}>;

const cursorSchema = z.object({
  w: z.boolean(),
  t: z.string().datetime().optional(),
  id: z.string().uuid().optional(),
});

export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(
    JSON.stringify({
      w: cursor.waiting,
      t: cursor.after?.lastMessageAt.toISOString(),
      id: cursor.after?.id,
    }),
  ).toString('base64url');
}

export function decodeInboxCursor(raw: string): InboxCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
  const result = cursorSchema.safeParse(parsed);
  if (
    !result.success ||
    (result.data.t === undefined) !== (result.data.id === undefined)
  ) {
    throw new BadRequestException('Invalid cursor');
  }
  const { w, t, id } = result.data;
  return {
    waiting: w,
    after: t && id ? { lastMessageAt: new Date(t), id } : undefined,
  };
}

/** Keyset condition for rooms ordered by `lastMessageAt desc, id desc`. */
export function afterRoom(after?: InboxCursor['after']) {
  if (!after) return {};
  return {
    OR: [
      { lastMessageAt: { lt: after.lastMessageAt } },
      { lastMessageAt: after.lastMessageAt, id: { lt: after.id } },
    ],
  };
}

export const INBOX_ROOM_ORDER = [
  { lastMessageAt: 'desc' as const },
  { id: 'desc' as const },
];

/**
 * Pages rooms in inbox order: every room waiting for an admin first, then the
 * rest, each group newest first. `fetch` loads one group past the keyset; it
 * is asked for one extra row to learn whether more remain.
 */
export async function pageInboxRooms<
  T extends { id: string; lastMessageAt: Date },
>(
  query: Pick<ListInboxConversationsQuery, 'limit' | 'cursor' | 'status'>,
  fetch: (
    waiting: boolean,
    after: InboxCursor['after'],
    take: number,
  ) => Promise<T[]>,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const limit = query.limit ?? INBOX_DEFAULT_PAGE_SIZE;
  const cursor = query.cursor ? decodeInboxCursor(query.cursor) : undefined;
  const groups = [true, false].filter(
    (waiting) =>
      (query.status === undefined ||
        waiting === (query.status === 'waiting_admin')) &&
      // A cursor in the second group never goes back to the first.
      (!cursor || cursor.waiting || !waiting),
  );

  const items: T[] = [];
  for (const waiting of groups) {
    const after = cursor?.waiting === waiting ? cursor.after : undefined;
    const need = limit - items.length;
    const rows = await fetch(waiting, after, need + 1);
    if (rows.length > need) {
      const page = rows.slice(0, need);
      items.push(...page);
      const last = page.at(-1);
      return {
        items,
        nextCursor: encodeInboxCursor({
          waiting,
          after: last
            ? { lastMessageAt: last.lastMessageAt, id: last.id }
            : after,
        }),
      };
    }
    items.push(...rows);
  }
  return { items, nextCursor: null };
}

/**
 * Message-history keyset. `beforeId`/`afterId` break ties between messages
 * stored in the same millisecond; without them the old date-only cursor holds.
 */
export function messageKeyset(
  before: Date | undefined,
  beforeId: string | undefined,
  after: Date | undefined,
  afterId: string | undefined,
) {
  if (beforeId && !before) {
    throw new BadRequestException('beforeId requires before');
  }
  if (afterId && !after) {
    throw new BadRequestException('afterId requires after');
  }
  if (after) {
    return afterId
      ? {
          OR: [
            { createdAt: { gt: after } },
            { createdAt: after, id: { gt: afterId } },
          ],
        }
      : { createdAt: { gt: after } };
  }
  if (before) {
    return beforeId
      ? {
          OR: [
            { createdAt: { lt: before } },
            { createdAt: before, id: { lt: beforeId } },
          ],
        }
      : { createdAt: { lt: before } };
  }
  return {};
}

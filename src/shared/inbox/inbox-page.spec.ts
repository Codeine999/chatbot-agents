import { BadRequestException } from '@nestjs/common';
import {
  decodeInboxCursor,
  encodeInboxCursor,
  isPagedInboxQuery,
  listInboxConversationsQuerySchema,
  messageKeyset,
  pageInboxRooms,
} from './inbox-page';

type Room = { id: string; lastMessageAt: Date; waiting: boolean };

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** In-memory stand-in for the per-group Prisma query the services pass in. */
function fakeFetch(rooms: Room[]) {
  const calls: { waiting: boolean; take: number }[] = [];
  const fetch = (
    waiting: boolean,
    after: { lastMessageAt: Date; id: string } | undefined,
    take: number,
  ) => {
    calls.push({ waiting, take });
    const rows = rooms
      .filter((room) => room.waiting === waiting)
      .filter(
        (room) =>
          !after ||
          room.lastMessageAt < after.lastMessageAt ||
          (room.lastMessageAt.getTime() === after.lastMessageAt.getTime() &&
            room.id < after.id),
      )
      .sort(
        (a, b) =>
          b.lastMessageAt.getTime() - a.lastMessageAt.getTime() ||
          (a.id < b.id ? 1 : -1),
      );
    return Promise.resolve(rows.slice(0, take));
  };
  return { fetch, calls };
}

async function readAll(
  rooms: Room[],
  limit: number,
  status?: 'waiting_admin' | 'open',
) {
  const { fetch } = fakeFetch(rooms);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await pageInboxRooms({ limit, cursor, status }, fetch);
    seen.push(...result.items.map((room) => room.id));
    if (!result.nextCursor) return seen;
    cursor = result.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

// 3 waiting rooms and 5 others; two pairs share a timestamp to test the id tie-break.
const t = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));
const rooms: Room[] = [
  { id: uuid(1), lastMessageAt: t(1), waiting: true },
  { id: uuid(2), lastMessageAt: t(5), waiting: true },
  { id: uuid(3), lastMessageAt: t(5), waiting: true },
  { id: uuid(4), lastMessageAt: t(9), waiting: false },
  { id: uuid(5), lastMessageAt: t(8), waiting: false },
  { id: uuid(6), lastMessageAt: t(8), waiting: false },
  { id: uuid(7), lastMessageAt: t(2), waiting: false },
  { id: uuid(8), lastMessageAt: t(7), waiting: false },
];
const expectedOrder = [3, 2, 1, 4, 6, 5, 8, 7].map(uuid);

describe('inbox room paging', () => {
  it.each([1, 2, 3, 4, 7, 8, 30])(
    'returns every room exactly once in inbox order at page size %i',
    async (limit) => {
      expect(await readAll(rooms, limit)).toEqual(expectedOrder);
    },
  );

  it('ends with a null cursor when the last page is exactly full', async () => {
    const { fetch } = fakeFetch(rooms);
    const first = await pageInboxRooms({ limit: 3 }, fetch);
    expect(first.items.map((room) => room.id)).toEqual(
      expectedOrder.slice(0, 3),
    );
    // The waiting group is exhausted, but other rooms remain.
    expect(first.nextCursor).not.toBeNull();

    const all = await pageInboxRooms({ limit: 8 }, fetch);
    expect(all.items).toHaveLength(8);
    expect(all.nextCursor).toBeNull();
  });

  it('keeps a status filter to its own group', async () => {
    expect(await readAll(rooms, 2, 'waiting_admin')).toEqual(
      expectedOrder.slice(0, 3),
    );
    expect(await readAll(rooms, 2, 'open')).toEqual(expectedOrder.slice(3));
  });

  it('does not query the waiting group again once past it', async () => {
    const { fetch, calls } = fakeFetch(rooms);
    const first = await pageInboxRooms({ limit: 4 }, fetch);
    calls.length = 0;
    await pageInboxRooms({ limit: 2, cursor: first.nextCursor! }, fetch);
    expect(calls.every((call) => !call.waiting)).toBe(true);
  });

  it('returns an empty page for an empty inbox', async () => {
    const { fetch } = fakeFetch([]);
    expect(await pageInboxRooms({}, fetch)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('inbox cursor', () => {
  it('round-trips a position and a group start', () => {
    const position = {
      waiting: false,
      after: { lastMessageAt: t(3), id: uuid(9) },
    };
    expect(decodeInboxCursor(encodeInboxCursor(position))).toEqual(position);
    expect(decodeInboxCursor(encodeInboxCursor({ waiting: true }))).toEqual({
      waiting: true,
      after: undefined,
    });
  });

  it.each([
    'not-base64-json',
    Buffer.from('{"w":"yes"}').toString('base64url'),
    Buffer.from('{"w":true,"t":"2026-11-01T10:00:00.000Z"}').toString(
      'base64url',
    ),
    Buffer.from('{"w":true,"t":"x","id":"y"}').toString('base64url'),
  ])('rejects a malformed cursor %s', (raw) => {
    expect(() => decodeInboxCursor(raw)).toThrow(BadRequestException);
  });
});

describe('inbox list query', () => {
  it('treats no parameters as the legacy unpaged request', () => {
    const query = listInboxConversationsQuerySchema.parse({});
    expect(isPagedInboxQuery(query)).toBe(false);
  });

  it('parses dashboard query strings', () => {
    const query = listInboxConversationsQuerySchema.parse({
      limit: '20',
      unread: 'true',
      status: 'waiting_admin',
      q: '  Nampun ',
      cursor: '',
    });
    expect(query).toEqual({
      limit: 20,
      unread: true,
      status: 'waiting_admin',
      q: 'Nampun',
      cursor: undefined,
    });
    expect(isPagedInboxQuery(query)).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(() =>
      listInboxConversationsQuerySchema.parse({ status: 'closed' }),
    ).toThrow();
  });
});

describe('message keyset', () => {
  const at = t(4);

  it('keeps the date-only cursor when no id is sent', () => {
    expect(messageKeyset(at, undefined, undefined, undefined)).toEqual({
      createdAt: { lt: at },
    });
    expect(messageKeyset(undefined, undefined, at, undefined)).toEqual({
      createdAt: { gt: at },
    });
    expect(messageKeyset(undefined, undefined, undefined, undefined)).toEqual(
      {},
    );
  });

  it('breaks same-millisecond ties by id', () => {
    expect(messageKeyset(at, uuid(5), undefined, undefined)).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: uuid(5) } }],
    });
    expect(messageKeyset(undefined, undefined, at, uuid(5))).toEqual({
      OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: uuid(5) } }],
    });
  });

  it('rejects an id without its date', () => {
    expect(() =>
      messageKeyset(undefined, uuid(1), undefined, undefined),
    ).toThrow(BadRequestException);
    expect(() =>
      messageKeyset(undefined, undefined, undefined, uuid(1)),
    ).toThrow(BadRequestException);
  });
});

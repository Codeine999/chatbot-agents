import { LineChatSender } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ListLineUsersQueryDto,
  ListRegisteredUsersQueryDto,
} from './dto/list-users.query.dto';
import { UsersService } from './users.service';

/** เก็บเฉพาะส่วนของ args ที่เทสต์ตรวจ ไม่ต้องอ้าง type เต็มของ Prisma */
type FindArgs = {
  where?: unknown;
  orderBy?: unknown;
  skip?: number;
  take?: number;
  select?: Record<string, unknown>;
};

type CountMock = jest.Mock<Promise<number>, [FindArgs]>;
type FindManyMock = jest.Mock<Promise<unknown[]>, [FindArgs]>;

const countMock = (total = 0): CountMock =>
  jest.fn<Promise<number>, [FindArgs]>().mockResolvedValue(total);

const findManyMock = (rows: unknown[] = []): FindManyMock =>
  jest.fn<Promise<unknown[]>, [FindArgs]>().mockResolvedValue(rows);

const lineQuery = (
  overrides: Partial<ListLineUsersQueryDto> = {},
): ListLineUsersQueryDto => ({
  sort: 'newest',
  page: 1,
  pageSize: 10,
  registered: 'false',
  ...overrides,
});

const registeredQuery = (
  overrides: Partial<ListRegisteredUsersQueryDto> = {},
): ListRegisteredUsersQueryDto => ({
  sort: 'newest',
  page: 1,
  pageSize: 10,
  ...overrides,
});

const makePrisma = (parts: {
  lineMember?: { count?: CountMock; findMany?: FindManyMock };
  member?: { count?: CountMock; findMany?: FindManyMock };
}) =>
  ({
    lineMember: {
      count: countMock(),
      findMany: findManyMock(),
      ...parts.lineMember,
    },
    member: {
      count: countMock(),
      findMany: findManyMock(),
      ...parts.member,
    },
  }) as unknown as PrismaService;

describe('UsersService.listLineUsers', () => {
  it('returns only unregistered LINE members and counts inbound messages', async () => {
    const findMany = findManyMock([
      {
        id: 'line-1',
        lineUserId: 'U1',
        displayName: 'Somchai',
        pictureUrl: 'https://cdn/p.jpg',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        lastActiveAt: new Date('2026-09-20T00:00:00.000Z'),
        _count: { chatHistories: 7 },
      },
    ]);
    const prisma = makePrisma({
      lineMember: { count: countMock(1), findMany },
    });

    const result = await new UsersService(prisma).listLineUsers(lineQuery());

    expect(result).toEqual({
      items: [
        {
          id: 'line-1',
          displayName: 'Somchai',
          lineId: 'U1',
          avatar: 'https://cdn/p.jpg',
          firstSeenAt: '2026-09-01T00:00:00.000Z',
          lastActiveAt: '2026-09-20T00:00:00.000Z',
          messageCount: 7,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ memberId: null });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }]);
    expect(args.select?._count).toEqual({
      select: { chatHistories: { where: { sender: LineChatSender.USER } } },
    });
  });

  it('keeps registered LINE members out unless asked, and searches both name and id', async () => {
    const count = countMock();
    const prisma = makePrisma({ lineMember: { count } });
    const service = new UsersService(prisma);

    await service.listLineUsers(lineQuery({ registered: 'true' }));
    expect(count.mock.calls[0][0].where).toEqual({ memberId: { not: null } });

    await service.listLineUsers(
      lineQuery({ registered: 'all', search: ' som ' }),
    );
    expect(count.mock.calls[1][0].where).toEqual({
      OR: [
        { displayName: { contains: 'som', mode: 'insensitive' } },
        { lineUserId: { contains: 'som', mode: 'insensitive' } },
      ],
    });
  });

  it('pulls the page back when the filter leaves fewer pages than requested', async () => {
    const findMany = findManyMock();
    const prisma = makePrisma({
      lineMember: { count: countMock(3), findMany },
    });

    const result = await new UsersService(prisma).listLineUsers(
      lineQuery({ page: 9, pageSize: 2 }),
    );

    expect(result.page).toBe(2);
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 2, take: 2 });
  });
});

describe('UsersService.listRegistered', () => {
  it('maps the most recent linked LINE profile onto the member', async () => {
    const findMany = findManyMock([
      {
        uuid: 'member-1',
        username: 'somchai.w',
        firstname: 'Somchai',
        lastname: 'Wong',
        phone: '0812345678',
        statusaccount: 'pending',
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
        lineMembers: [
          {
            lineUserId: 'U1',
            displayName: 'Somchai',
            pictureUrl: null,
            lastActiveAt: null,
          },
        ],
      },
      {
        uuid: 'member-2',
        username: 'natcha.p',
        firstname: 'Natcha',
        lastname: 'Pim',
        phone: '0898765432',
        statusaccount: 'pending',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        lineMembers: [],
      },
    ]);
    const prisma = makePrisma({
      member: { count: countMock(2), findMany },
    });

    const result = await new UsersService(prisma).listRegistered(
      registeredQuery(),
    );

    expect(result.items[0]).toEqual({
      id: 'member-1',
      name: 'Somchai Wong',
      username: 'somchai.w',
      phone: '0812345678',
      status: 'pending',
      joinedAt: '2026-09-02T00:00:00.000Z',
      lineId: 'U1',
      lineName: 'Somchai',
      avatar: null,
      lastActiveAt: null,
    });
    // ไม่เคยผูก LINE ต้องไม่พังและไม่หลุดค่าจากแถวก่อนหน้า
    expect(result.items[1]).toMatchObject({
      lineId: null,
      lineName: null,
      avatar: null,
      lastActiveAt: null,
    });
  });

  it('filters by account status and searches name, username, phone and LINE name', async () => {
    const count = countMock();
    const prisma = makePrisma({ member: { count } });
    const service = new UsersService(prisma);

    await service.listRegistered(registeredQuery({ status: 'all' }));
    expect(count.mock.calls[0][0].where).toEqual({});

    await service.listRegistered(
      registeredQuery({ status: 'pending', search: 'nat' }),
    );
    expect(count.mock.calls[1][0].where).toEqual({
      statusaccount: 'pending',
      OR: [
        { firstname: { contains: 'nat', mode: 'insensitive' } },
        { lastname: { contains: 'nat', mode: 'insensitive' } },
        { username: { contains: 'nat', mode: 'insensitive' } },
        { phone: { contains: 'nat' } },
        {
          lineMembers: {
            some: { displayName: { contains: 'nat', mode: 'insensitive' } },
          },
        },
      ],
    });
  });
});

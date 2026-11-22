/**
 * Inserts fake LINE rooms (lineMember + lineConversation) for inbox and
 * presence testing. Local database only.
 *
 *   bun run seed:mock-line-rooms                  # create 30 rooms (idempotent)
 *   bun run seed:mock-line-rooms -- --count=50    # create 50 rooms
 *   bun run seed:mock-line-rooms -- --clean       # delete every mock room
 *
 * Rows use the lineUserId prefix `Umock`, so `--clean` removes only these.
 * The fake LINE ids cannot receive real pushes, so an admin reply to them is
 * expected to fail delivery; that is fine for UI testing.
 *
 * Refuses to run unless DATABASE_URL points at localhost / 127.0.0.1.
 */
import {
  LineChatMessageType,
  LineMemberGrade,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { failOnError, runSeed } from './run-seed';

const MOCK_PREFIX = 'Umock';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_COUNT = 30;
const MAX_COUNT = 500;

const NAMES = [
  'สมศรี ใจดี',
  'สมชาย รักษ์ไทย',
  'วิไล แสงทอง',
  'ประเสริฐ มั่งมี',
  'นภา ศรีสุข',
  'อนันต์ พงษ์พันธ์',
  'กัญญา บุญมา',
  'ธนพล เจริญ',
  'พรทิพย์ วงศ์ดี',
  'สุรชัย ทองคำ',
];

const MESSAGES = [
  'รอบรถกรุงเทพ-เชียงใหม่ พรุ่งนี้มีกี่รอบ',
  'ขอเปลี่ยนที่นั่งได้ไหมคะ',
  'ตั๋วหายต้องทำยังไง',
  'รถล่าช้าไหมคะ ตอนนี้อยู่ไหนแล้ว',
  'มีที่นั่งว่างเหลือกี่ที่',
  'ขอใบเสร็จย้อนหลังได้ไหม',
  'สอบถามค่าโดยสารเด็กอายุ 5 ขวบ',
  'ยกเลิกตั๋วแล้วได้เงินคืนเมื่อไหร่',
];

const parseCount = (argv: string[]): number => {
  const raw = argv.find((arg) => arg.startsWith('--count='))?.split('=')[1];
  if (raw === undefined) return DEFAULT_COUNT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_COUNT)
    throw new Error(`--count must be an integer between 1 and ${MAX_COUNT}`);
  return value;
};

const assertLocalDatabase = (): void => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host))
    throw new Error(
      `Refusing to seed: DATABASE_URL host "${host}" is not local`,
    );
};

const mockUserId = (index: number) =>
  `${MOCK_PREFIX}${String(index).padStart(4, '0')}`;

failOnError(
  runSeed(async (app) => {
    assertLocalDatabase();
    const prisma = app.get(PrismaService);

    if (process.argv.includes('--clean')) {
      const removed = await prisma.lineConversation.deleteMany({
        where: { lineMember: { lineUserId: { startsWith: MOCK_PREFIX } } },
      });
      const members = await prisma.lineMember.deleteMany({
        where: { lineUserId: { startsWith: MOCK_PREFIX } },
      });
      console.log(
        `removed ${removed.count} mock conversations, ${members.count} mock members`,
      );
      return;
    }

    const count = parseCount(process.argv);
    const now = Date.now();

    for (let index = 1; index <= count; index += 1) {
      const lineUserId = mockUserId(index);
      const name = NAMES[index % NAMES.length];
      const waiting = index % 5 === 0;
      const lastMessage = MESSAGES[index % MESSAGES.length];
      // Spread timestamps so the inbox order is stable and realistic.
      const lastMessageAt = new Date(now - index * 7 * 60_000);

      const member = await prisma.lineMember.upsert({
        where: { lineUserId },
        update: {},
        create: {
          lineUserId,
          displayName: `${name} (${index})`,
          grade: LineMemberGrade.NORMAL,
          lastActiveAt: lastMessageAt,
        },
      });

      await prisma.lineConversation.upsert({
        where: { lineMemberId: member.id },
        update: {},
        create: {
          lineMemberId: member.id,
          status: waiting ? 'waiting_admin' : 'open',
          lastMessage,
          lastMessageType: LineChatMessageType.TEXT,
          lastMessageAt,
          unreadCount: index % 3 === 0 ? (index % 4) + 1 : 0,
        },
      });
    }

    console.log(
      `ensured ${count} mock LINE rooms (lineUserId ${mockUserId(1)}..${mockUserId(count)})`,
    );
  }),
);

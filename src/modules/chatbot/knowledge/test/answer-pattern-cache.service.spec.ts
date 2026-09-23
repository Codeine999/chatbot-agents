import { AnswerPatternCacheService } from '../answer-pattern-cache.service';
import type { PrismaService } from '../../../../prisma/prisma.service';
import { configStub, makePattern } from './knowledge.fixtures';

const TTL_MS = 240_000;

type FindManyArgs = { where?: unknown; orderBy?: unknown; take?: number };
type FindManyMock = jest.Mock<Promise<unknown[]>, [FindManyArgs]>;

const findManyMock = (rows: unknown[] = []): FindManyMock =>
  jest.fn<Promise<unknown[]>, [FindManyArgs]>().mockResolvedValue(rows);

const makeCache = (findMany: FindManyMock, env: Record<string, string> = {}) =>
  new AnswerPatternCacheService(
    { answerPattern: { findMany } } as unknown as PrismaService,
    configStub(env),
  );

describe('AnswerPatternCacheService', () => {
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('โหลดเฉพาะแถว active ใน scope เรียงตาม priority ไม่เกิน 500 แถว', async () => {
    const rows = [makePattern()];
    const findMany = findManyMock(rows);
    const cache = makeCache(findMany);

    await cache.refresh();

    expect(findMany).toHaveBeenCalledWith({
      where: { active: true, tenantId: null, language: 'th' },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      take: 500,
    });
    expect(cache.getAll()).toEqual(rows);
  });

  it('ยังไม่เคยโหลด = ไม่มีข้อมูลให้ใช้ทางลัด', () => {
    expect(makeCache(findManyMock()).getAll()).toEqual([]);
  });

  it('พอหมดอายุ คืนค่าว่างทันที (ห้ามตอบตรงจากข้อมูลเก่า) แล้วค่อยโหลดใหม่เบื้องหลัง', async () => {
    const findMany = findManyMock([makePattern()]);
    const cache = makeCache(findMany);
    await cache.refresh();

    now += TTL_MS + 1;
    expect(cache.getAll()).toEqual([]);

    expect(findMany).toHaveBeenCalledTimes(2);
    await cache.refresh();
    expect(cache.getAll()).toHaveLength(1);
  });

  it('ยังไม่หมดอายุ ใช้ snapshot เดิม ไม่ยิง query ซ้ำ', async () => {
    const findMany = findManyMock([makePattern()]);
    const cache = makeCache(findMany);
    await cache.refresh();

    now += TTL_MS - 1;
    expect(cache.getAll()).toHaveLength(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('เรียก refresh พร้อมกันหลายครั้ง ยิง query เดียว (กันแตกตอนทราฟฟิกเข้าพร้อมกัน)', async () => {
    let release!: (rows: unknown[]) => void;
    const findMany = findManyMock();
    findMany.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const cache = makeCache(findMany);

    const first = cache.refresh();
    const second = cache.refresh();
    release([makePattern()]);
    await Promise.all([first, second]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(cache.getAll()).toHaveLength(1);

    // รอบถัดไปหลังรอบแรกจบ ต้องยิงใหม่ได้ ไม่ใช่ค้างสถานะ in-flight
    await cache.refresh();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('DB ล่ม ต้องไม่โยน error และยังเสิร์ฟ snapshot เดิมต่อได้', async () => {
    const findMany = findManyMock([makePattern()]);
    const cache = makeCache(findMany);
    await cache.refresh();

    findMany.mockRejectedValueOnce(new Error('connection lost'));
    await expect(cache.refresh()).resolves.toBeUndefined();

    expect(cache.getAll()).toHaveLength(1);
  });

  it('โหลดครั้งแรกตอน boot แล้วตั้งรอบรีเฟรช และเก็บกวาดตอนปิดโมดูล', async () => {
    jest.useFakeTimers();
    try {
      const findMany = findManyMock([makePattern()]);
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      const cache = makeCache(findMany);

      await cache.onModuleInit();
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);

      cache.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

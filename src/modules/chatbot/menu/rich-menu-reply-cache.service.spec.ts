import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RichMenuReplyCacheService } from './rich-menu-reply-cache.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  tenantId: TENANT,
  key: 'register',
  label: 'สมัครสมาชิก',
  replyText: 'กรอกข้อมูลตามนี้ครับ',
  active: true,
  sortOrder: 0,
  createdByAdminId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function build(rows = [row()], tenantId: string | null = TENANT) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = {
    richMenuReply: { findMany },
  } as unknown as PrismaService;
  const config = new ConfigService(
    tenantId ? { LINE_CHANNEL_TENANT_ID: tenantId } : {},
  );

  return { findMany, service: new RichMenuReplyCacheService(prisma, config) };
}

describe('RichMenuReplyCacheService', () => {
  it('uses the null scope even when future tenant configuration exists', async () => {
    const { findMany, service } = build();

    await service.refresh();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: null, active: true },
      }),
    );
    expect(service.byKey('register')?.replyText).toBe('กรอกข้อมูลตามนี้ครับ');
  });

  it('resolves a raw postback value and marks how it matched', async () => {
    const { service } = build();
    await service.refresh();

    expect(service.byPostbackData('menu=register')).toMatchObject({
      key: 'register',
      via: 'POSTBACK',
    });
    expect(service.byPostbackData('intent=REGISTER')).toBeNull();
    expect(service.byPostbackData('anything else')).toBeNull();
  });

  it('matches a typed caption exactly, ignoring case and padding', async () => {
    const { service } = build();
    await service.refresh();

    expect(service.byLabel('  สมัครสมาชิก ')).toMatchObject({
      key: 'register',
      via: 'LABEL',
    });
  });

  it('does not match a caption that merely contains the label', async () => {
    const { service } = build();
    await service.refresh();

    // A question about registering belongs to retrieval, not to the button.
    expect(service.byLabel('สมัครสมาชิกยังไงครับ')).toBeNull();
  });

  it('gives the tenant order the final say when two buttons share a caption', async () => {
    const { service } = build([
      row({ id: 'r1', key: 'first', label: 'ติดต่อเรา', sortOrder: 0 }),
      row({ id: 'r2', key: 'second', label: 'ติดต่อเรา', sortOrder: 1 }),
    ]);
    await service.refresh();

    expect(service.byLabel('ติดต่อเรา')?.key).toBe('first');
  });

  it('misses cleanly for a button whose reply was deleted', async () => {
    const { service } = build([]);
    await service.refresh();

    expect(service.byKey('gone')).toBeNull();
    expect(service.labels()).toEqual([]);
  });

  it('a forced refresh reads again instead of joining one already running', async () => {
    // The race this closes: an admin saves a reply while another refresh
    // is mid-query. Joining that query would settle on rows read before the
    // save committed, and the admin would be told the bot is up to date.
    const { findMany, service } = build([]);

    let releaseFirst: () => void = () => {};
    findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([]);
        }),
    );

    const periodic = service.refresh();
    // The query only starts on a later microtask, so wait for it to be open.
    await new Promise((resolve) => setImmediate(resolve));

    // ...the row lands in the database while that query is still open.
    findMany.mockResolvedValue([row()]);

    const forced = service.refresh({ force: true });
    releaseFirst();

    await Promise.all([periodic, forced]);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(service.byKey('register')?.label).toBe('สมัครสมาชิก');
  });

  it('a plain refresh still joins one already running', async () => {
    const { findMany, service } = build();

    await Promise.all([service.refresh(), service.refresh()]);

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last snapshot when a refresh fails', async () => {
    const { findMany, service } = build();
    await service.refresh();

    findMany.mockRejectedValue(new Error('database down'));
    await service.refresh();

    expect(service.byKey('register')?.label).toBe('สมัครสมาชิก');
  });

  it('serves captions in the tenant own order', async () => {
    const { service } = build([
      row({ id: 'r1', key: 'a', label: 'หนึ่ง' }),
      row({ id: 'r2', key: 'b', label: 'สอง' }),
    ]);
    await service.refresh();

    expect(service.labels()).toEqual(['หนึ่ง', 'สอง']);
  });

  it('runs in the legacy null scope when no channel tenant is configured', async () => {
    const { findMany, service } = build([row({ tenantId: null })], null);

    await service.refresh();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: null, active: true } }),
    );
  });
});

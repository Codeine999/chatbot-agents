import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { LineRichMenuClient } from './line-rich-menu.client';
import { RichMenuImageService } from './rich-menu-image.service';
import { RichMenuService } from './rich-menu.service';
import type { ApplyRichMenuLayoutDto } from './dto/rich-menu.dto';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

const template = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  tenantId: TENANT,
  name: 'เมนูหลัก',
  chatBarText: 'เมนู',
  width: 2500,
  height: 1686,
  selected: true,
  areas: [
    {
      bounds: { x: 0, y: 0, width: 2500, height: 1686 },
      action: { type: 'postback', data: 'menu=register' },
    },
  ],
  cellImages: null,
  imagePath: null,
  imageMimeType: null,
  imageBytes: null,
  status: 'DRAFT',
  lineRichMenuId: null,
  lineAliasId: null,
  isDefault: false,
  needsRepublish: false,
  publishedAt: null,
  lastPublishError: null,
  createdByAdminId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function build(channelTenantId: string | null = TENANT) {
  // The transaction callback runs against the same mock, so a scoped write
  // inside a transaction is asserted exactly like one outside it.
  const prismaRef: { value: unknown } = { value: null };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 't1' }]),
    richMenuTemplate: {
      findMany: jest.fn().mockResolvedValue([template()]),
      findFirst: jest.fn().mockResolvedValue(template()),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve(template(data))),
      update: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve(template(data))),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue(template()),
    },
    $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
      callback(prismaRef.value),
    ),
    richMenuReply: {
      findMany: jest.fn().mockResolvedValue([
        {
          key: 'register',
          label: 'สมัครสมาชิก',
          replyText: 'กรอกข้อมูล',
        },
      ]),
    },
  };

  prismaRef.value = prisma;

  const lineClient = {
    setDefault: jest.fn().mockResolvedValue(undefined),
    clearDefault: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
    getDefault: jest.fn().mockResolvedValue(null),
    listAliases: jest.fn().mockResolvedValue([]),
    validate: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as LineRichMenuClient;

  const config = new ConfigService(
    channelTenantId ? { LINE_CHANNEL_TENANT_ID: channelTenantId } : {},
  );

  return {
    prisma,
    lineClient,
    service: new RichMenuService(
      prisma as unknown as PrismaService,
      lineClient,
      new RichMenuImageService(),
      config,
    ),
  };
}

describe('RichMenuService tenant scoping', () => {
  it('lists only the caller tenant menus', async () => {
    const { prisma, service } = build();

    await service.list(TENANT, {} as never);

    expect(prisma.richMenuTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT }),
      }),
    );
  });

  it('stamps the caller tenant on create', async () => {
    const { prisma, service } = build();

    await service.create(
      TENANT,
      {
        name: 'x',
        chatBarText: 'y',
        size: { width: 2500, height: 1686 },
        selected: true,
        areas: template().areas,
      } as never,
      'admin-1',
    );

    expect(prisma.richMenuTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: TENANT }),
    });
  });

  it('cannot fetch another tenant menu by id', async () => {
    const { prisma, service } = build();
    prisma.richMenuTemplate.findFirst.mockResolvedValue(null);

    await expect(service.get(OTHER_TENANT, 't1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.richMenuTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', tenantId: OTHER_TENANT },
    });
  });

  it('clears the previous default only inside the caller tenant', async () => {
    // Unscoped this would silently drop another tenant's default menu.
    const { prisma, service } = build();
    prisma.richMenuTemplate.findFirst.mockResolvedValue(
      template({ lineRichMenuId: 'richmenu-abc', status: 'PUBLISHED' }),
    );

    await service.setDefault(null, 't1');

    expect(prisma.richMenuTemplate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: null, id: { not: 't1' }, isDefault: true },
      data: { isDefault: false },
    });
  });

  it('refuses to touch the LINE channel from a tenant that does not own it', async () => {
    const { service, lineClient } = build(OTHER_TENANT);

    await expect(service.clearDefault(TENANT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(lineClient.clearDefault).not.toHaveBeenCalled();
  });

  it('will not call an orphan a menu that belongs to someone else', async () => {
    const { prisma, service, lineClient } = build();
    prisma.richMenuTemplate.findUnique.mockResolvedValue({
      id: 'other',
      tenantId: OTHER_TENANT,
    });

    await expect(
      service.removeOrphanOnLine(TENANT, 'richmenu-abc'),
    ).rejects.toThrow(/another tenant/);
    expect(lineClient.remove).not.toHaveBeenCalled();
  });
});

describe('RichMenuService.applyLayout', () => {
  const layout = (over: Partial<ApplyRichMenuLayoutDto> = {}) =>
    ({
      cells: 2,
      buttons: [{ replyKey: 'register' }, null],
      ...over,
    }) as ApplyRichMenuLayoutDto;

  it('derives bounds and postback data from the chosen replies', async () => {
    const { prisma, service } = build();

    await service.applyLayout(TENANT, 't1', layout());

    const written = prisma.richMenuTemplate.update.mock.calls[0][0].data
      .areas as unknown[];

    expect(written).toEqual([
      {
        bounds: { x: 0, y: 0, width: 1250, height: 1686 },
        action: {
          type: 'postback',
          label: 'สมัครสมาชิก',
          data: 'menu=register',
          displayText: 'สมัครสมาชิก',
        },
      },
    ]);
  });

  it('looks replies up inside the caller tenant only', async () => {
    const { prisma, service } = build();

    await service.applyLayout(TENANT, 't1', layout());

    expect(prisma.richMenuReply.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, key: { in: ['register'] } },
    });
  });

  it('refuses a button pointing at a reply that does not exist', async () => {
    const { prisma, service } = build();
    prisma.richMenuReply.findMany.mockResolvedValue([]);

    await expect(
      service.applyLayout(TENANT, 't1', layout()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.richMenuTemplate.update).not.toHaveBeenCalled();
  });

  it('refuses a menu where nothing is tappable', async () => {
    const { service } = build();

    await expect(
      service.applyLayout(TENANT, 't1', layout({ buttons: [null, null] })),
    ).rejects.toThrow(/at least one button/);
  });

  it('supports a link button beside an answering one', async () => {
    const { prisma, service } = build();

    await service.applyLayout(
      TENANT,
      't1',
      layout({
        buttons: [{ replyKey: 'register' }, { uri: 'https://example.com' }],
      }),
    );

    const written = prisma.richMenuTemplate.update.mock.calls[0][0].data
      .areas as { action: { type: string } }[];

    expect(written.map((area) => area.action.type)).toEqual([
      'postback',
      'uri',
    ]);
  });

  it('marks a published menu as needing a republish', async () => {
    const { prisma, service } = build();
    prisma.richMenuTemplate.findFirst.mockResolvedValue(
      template({ lineRichMenuId: 'richmenu-abc', status: 'PUBLISHED' }),
    );

    await service.applyLayout(TENANT, 't1', layout());

    expect(prisma.richMenuTemplate.update.mock.calls[0][0].data).toMatchObject({
      needsRepublish: true,
    });
  });
});

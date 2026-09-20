/**
 * Exercises the whole rich menu path against the real database: tenant
 * scoping, the reply table, the layout derivation and the image compositing.
 * LINE itself is stubbed — no automated test may send a live LINE request.
 */
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { PrismaService } from '../../../prisma/prisma.service';
import { LineRichMenuClient } from './line-rich-menu.client';
import { RichMenuImageService } from './rich-menu-image.service';
import { RichMenuReplyService } from './rich-menu-reply.service';
import { RichMenuReplyCacheService } from '../../chatbot/menu/rich-menu-reply-cache.service';
import { RichMenuService } from './rich-menu.service';
import type { CreateRichMenuTemplateDto } from './dto/rich-menu.dto';
import type { FastifyRequest } from 'fastify';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const png = (size: number) =>
  sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 20, g: 120, b: 220 },
    },
  })
    .png()
    .toBuffer();

/** A multipart request carrying exactly one `image` part. */
const uploadRequest = (buffer: Buffer): FastifyRequest =>
  ({
    isMultipart: () => true,
    parts: () =>
      (async function* () {
        yield {
          type: 'file',
          fieldname: 'image',
          filename: 'cell.png',
          mimetype: 'image/png',
          file: { truncated: false },
          toBuffer: async () => buffer,
        };
      })(),
  }) as unknown as FastifyRequest;

describeIfDb('rich menu end to end (real database, stubbed LINE)', () => {
  let prisma: PrismaService;
  let service: RichMenuService;
  let replies: RichMenuReplyService;
  let images: RichMenuImageService;

  const tenants: string[] = [];
  const created: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }),
    );
    images = new RichMenuImageService();
    replies = new RichMenuReplyService(
      prisma,
      // The bot's in-memory copy is not part of what this spec checks.
      { refresh: async () => undefined } as RichMenuReplyCacheService,
    );
    service = new RichMenuService(
      prisma,
      {} as LineRichMenuClient,
      images,
      new ConfigService({}),
    );
  });

  afterAll(async () => {
    for (const id of created) {
      await prisma.richMenuTemplate.deleteMany({ where: { id } });
    }
    // Menus and replies cascade with their company.
    for (const id of tenants) {
      await prisma.company.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  });

  const makeTenant = async () => {
    const company = await prisma.company.create({
      data: { name: `rich-menu-test-${Date.now()}-${tenants.length}` },
    });
    tenants.push(company.id);
    return company.id;
  };

  const draft = {
    name: 'เมนูหลัก',
    chatBarText: 'เมนู',
    size: { width: 2500, height: 1686 },
    selected: true,
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 1686 },
        action: { type: 'uri', uri: 'https://line.me' },
      },
    ],
  } as unknown as CreateRichMenuTemplateDto;

  it('builds a 6-cell menu from replies and composites one LINE image', async () => {
    const tenant = await makeTenant();

    await replies.create(tenant, {
      key: 'register',
      label: 'สมัครสมาชิก',
      replyText: 'กรอกข้อมูลตามนี้ครับ',
      active: true,
      sortOrder: 0,
    } as never);

    await replies.create(tenant, {
      key: 'promo_today',
      label: 'โปรวันนี้',
      replyText: 'วันนี้ลด 20% ครับ',
      active: true,
      sortOrder: 1,
    } as never);

    const menu = await service.create(tenant, draft);
    created.push(menu.id);

    const laid = await service.applyLayout(tenant, menu.id, {
      cells: 6,
      buttons: [
        { replyKey: 'register' },
        { replyKey: 'promo_today' },
        null,
        null,
        null,
        { uri: 'https://example.com' },
      ],
    } as never);

    expect(laid.areas).toHaveLength(3);
    expect(laid.areas[0].action).toMatchObject({
      type: 'postback',
      data: 'menu=register',
      displayText: 'สมัครสมาชิก',
    });
    // Cell 5 of a 3x2 grid is the bottom-right corner.
    expect(laid.areas[2].bounds).toEqual({
      x: 1667,
      y: 843,
      width: 833,
      height: 843,
    });

    // Two uploads into a six-cell menu: the image must still be a full canvas.
    const withFirst = await service.uploadCellImage(
      tenant,
      menu.id,
      0,
      uploadRequest(await png(300)),
    );
    expect(withFirst.cellImages).toHaveLength(1);

    const withSecond = await service.uploadCellImage(
      tenant,
      menu.id,
      4,
      uploadRequest(await png(120)),
    );

    expect(withSecond.cellImages.map((cell) => cell.index)).toEqual([0, 4]);
    expect(withSecond.imagePath).toBeTruthy();
    expect(withSecond.imageBytes).toBeLessThanOrEqual(1024 * 1024);

    const composited = await service['readStoredImage'](
      withSecond.imagePath as string,
    );
    const meta = await sharp(composited).metadata();
    expect(meta.width).toBe(2500);
    expect(meta.height).toBe(1686);

    // Dropping to 2 cells retires the cell-4 upload that no longer has a home.
    const shrunk = await service.applyLayout(tenant, menu.id, {
      cells: 2,
      buttons: [{ replyKey: 'register' }, { replyKey: 'promo_today' }],
    } as never);

    expect(shrunk.cellImages.map((cell) => cell.index)).toEqual([0]);
    expect(shrunk.areas).toHaveLength(2);
  }, 30_000);

  it('keeps two tenants from seeing or touching each other menus', async () => {
    const first = await makeTenant();
    const second = await makeTenant();

    const mine = await service.create(first, draft);
    created.push(mine.id);

    await expect(service.get(second, mine.id)).rejects.toThrow(/not found/i);
    expect(await service.list(second, {} as never)).toEqual([]);
    expect((await service.list(first, {} as never)).map((m) => m.id)).toEqual([
      mine.id,
    ]);

    // Same key in two tenants is allowed; the unique index is per tenant.
    await replies.create(first, {
      key: 'register',
      label: 'A',
      replyText: 'a',
      active: true,
      sortOrder: 0,
    } as never);

    await expect(
      replies.create(second, {
        key: 'register',
        label: 'B',
        replyText: 'b',
        active: true,
        sortOrder: 0,
      } as never),
    ).resolves.toMatchObject({ key: 'register' });

    // ...but twice in one tenant is a conflict.
    await expect(
      replies.create(first, {
        key: 'register',
        label: 'A again',
        replyText: 'a',
        active: true,
        sortOrder: 0,
      } as never),
    ).rejects.toThrow(/already used/i);
  }, 30_000);

  it('refuses to delete a reply a menu still points at', async () => {
    const tenant = await makeTenant();

    const reply = await replies.create(tenant, {
      key: 'contact',
      label: 'ติดต่อแอดมิน',
      replyText: 'แอดมินกำลังมาครับ',
      active: true,
      sortOrder: 0,
    } as never);

    const menu = await service.create(tenant, draft);
    created.push(menu.id);

    await service.applyLayout(tenant, menu.id, {
      cells: 1,
      buttons: [{ replyKey: 'contact' }],
    } as never);

    await expect(replies.remove(tenant, reply.id)).rejects.toThrow(
      /still used/i,
    );

    const listed = await replies.list(tenant, {} as never);
    expect(listed[0].usedByTemplates).toHaveLength(1);
  }, 30_000);
});

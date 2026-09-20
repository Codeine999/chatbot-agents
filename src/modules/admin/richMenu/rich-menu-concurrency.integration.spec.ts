import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { PrismaService } from '../../../prisma/prisma.service';
import { RichMenuService } from './rich-menu.service';
import { RichMenuImageService } from './rich-menu-image.service';
import type { LineRichMenuClient } from './line-rich-menu.client';

// Explicit opt-in: writes only a newly created null-scope fixture and removes it.
const integration =
  process.env.RICH_MENU_CONCURRENCY_TEST === 'true' && process.env.DATABASE_URL
    ? describe
    : describe.skip;

integration('rich menu concurrency with independent PostgreSQL clients', () => {
  const clients: PrismaService[] = [];
  const services: RichMenuService[] = [];
  let id: string | undefined;
  const request = (buffer: Buffer) =>
    ({
      isMultipart: () => true,
      parts: async function* () {
        await Promise.resolve();
        yield {
          type: 'file',
          fieldname: 'image',
          filename: 'fixture.png',
          mimetype: 'image/png',
          file: { truncated: false },
          toBuffer: () => Promise.resolve(buffer),
        };
      },
    }) as unknown as FastifyRequest;

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const db = new PrismaService(
        new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }),
      );
      clients.push(db);
      services.push(
        new RichMenuService(
          db,
          {} as LineRichMenuClient,
          new RichMenuImageService(),
          new ConfigService({}),
        ),
      );
      await db.$connect();
    }
    const menu = await services[0].create(null, {
      name: 'concurrency-fixture-' + Date.now(),
      chatBarText: 'test',
      size: { width: 2500, height: 1686 },
      selected: true,
      areas: [
        {
          bounds: { x: 0, y: 0, width: 2500, height: 1686 },
          action: { type: 'message', text: 'test' },
        },
      ],
    });
    id = menu.id;
    await services[0].applyLayout(null, id, {
      cells: 6,
      buttons: [{ action: { type: 'message', text: 'test' } }],
    });
  });

  afterAll(async () => {
    try {
      if (id) await services[0].remove(null, id);
      if (id)
        expect(await clients[0].richMenuTemplate.count({ where: { id } })).toBe(
          0,
        );
    } finally {
      await Promise.all(clients.map((db) => db.$disconnect()));
    }
  });

  it('keeps both simultaneous uploads across ten rounds and independent connections', async () => {
    const red = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const blue = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();
    for (let round = 0; round < 10; round++) {
      await Promise.all([
        services[0].uploadCellImage(null, id!, 0, request(red)),
        services[1].uploadCellImage(null, id!, 4, request(blue)),
      ]);
      const result = await services[0].get(null, id!);
      expect(result.cellImages.map((cell) => cell.index)).toEqual([0, 4]);
      const buffer = await services[0]['readStoredImage'](result.imagePath!);
      const sample = async (left: number, top: number) =>
        sharp(buffer)
          .extract({ left, top, width: 1, height: 1 })
          .raw()
          .toBuffer();
      const first = await sample(100, 100);
      const fourth = await sample(1000, 1000);
      expect(first[0]).toBeGreaterThan(200);
      expect(first[2]).toBeLessThan(30);
      expect(fourth[2]).toBeGreaterThan(200);
      expect(fourth[0]).toBeLessThan(30);
      expect(result.imageBytes).toBeLessThanOrEqual(1024 * 1024);
    }
  }, 90_000);

  it('serializes simultaneous removals and clears the last composed image', async () => {
    await Promise.all([
      services[0].removeCellImage(null, id!, 0),
      services[1].removeCellImage(null, id!, 4),
    ]);
    const row = await clients[0].richMenuTemplate.findUniqueOrThrow({
      where: { id },
    });
    expect(row.cellImages).toEqual([]);
    expect(row.imagePath).toBeNull();
    expect(row.imageMimeType).toBeNull();
    expect(row.imageBytes).toBeNull();
  }, 30_000);
});

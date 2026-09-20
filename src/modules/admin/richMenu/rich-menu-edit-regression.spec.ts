import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../../prisma/prisma.service';
import { RichMenuService } from './rich-menu.service';
import { RichMenuImageService, type CellRect } from './rich-menu-image.service';
import { LineRichMenuClient } from './line-rich-menu.client';
import { ApplyRichMenuLayoutDto } from './dto/rich-menu.dto';
import { tenantOf } from './rich-menu-tenant';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { CreateAdminDto } from '../auth/dto/create-admin.dto';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

function setup() {
  let row = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: null,
    name: 'test',
    chatBarText: 'menu',
    width: 2500,
    height: 1686,
    selected: true,
    cellCount: 6,
    areas: [
      {
        bounds: { x: 0, y: 0, width: 833, height: 843 },
        action: { type: 'postback', data: 'intent=REGISTER' },
      },
    ],
    cellImages: [] as Array<{
      index: number;
      path: string;
      mimeType: string;
      bytes: number;
      width: number;
      height: number;
    }>,
    imagePath: null as string | null,
    lineRichMenuId: null,
  };
  let tail = Promise.resolve();
  let locked = false;
  const db = {
    $queryRaw: jest
      .fn<Promise<Array<{ id: string }>>, [{ strings: string[] }]>()
      .mockImplementation(() => {
        locked = true;
        return Promise.resolve([{ id: row.id }]);
      }),
    richMenuTemplate: {
      findFirst: jest.fn().mockImplementation(() => {
        expect(locked).toBe(true);
        return Promise.resolve(structuredClone(row));
      }),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Partial<typeof row> }) => {
          row = { ...row, ...data };
          return Promise.resolve(structuredClone(row));
        }),
    },
    richMenuReply: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(
    (run: (tx: unknown) => Promise<unknown>) => {
      const result = tail.then(() => run(db));
      tail = result.then(
        () => {
          locked = false;
        },
        () => {
          locked = false;
        },
      );
      return result;
    },
  );
  const images = {
    cellRects: (cells: number, width: number, height: number) =>
      new RichMenuImageService().cellRects(cells, width, height),
    storeCell: jest.fn().mockImplementation((_buffer: Buffer, rect: CellRect) =>
      Promise.resolve({
        index: rect.index,
        path: '/uploads/richmenu/cells/test.png',
        width: rect.width,
        height: rect.height,
        mimeType: 'image/png',
        bytes: 1,
      }),
    ),
    composite: jest.fn().mockResolvedValue({
      buffer: Buffer.from('image'),
      mimeType: 'image/png',
    }),
    removeCellImages: jest.fn().mockResolvedValue(undefined),
  };
  const service = new RichMenuService(
    db as unknown as PrismaService,
    {} as LineRichMenuClient,
    images as unknown as RichMenuImageService,
    new ConfigService({}),
  );
  const request = {
    isMultipart: () => true,
    parts: async function* () {
      await Promise.resolve();
      yield {
        type: 'file',
        fieldname: 'image',
        filename: 'test.png',
        mimetype: 'image/png',
        file: { truncated: false },
        toBuffer: () => Promise.resolve(Buffer.from('test')),
      };
    },
  } as unknown as FastifyRequest;
  return { service, db, images, request, row: () => row };
}

describe('rich menu edit regressions', () => {
  it('preserves both cells in concurrent uploads and locks before reading', async () => {
    const ctx = setup();
    const id = ctx.row().id;
    await Promise.all([
      ctx.service.uploadCellImage(null, id, 0, ctx.request),
      ctx.service.uploadCellImage(null, id, 4, ctx.request),
    ]);
    expect(ctx.row().cellImages.map((cell) => cell.index)).toEqual([0, 4]);
    const sql = ctx.db.$queryRaw.mock.calls[0][0];
    expect(sql.strings.join('')).toContain('FOR UPDATE');
  });

  it('clears the composed image when the last cell is removed', async () => {
    const ctx = setup();
    await ctx.service.uploadCellImage(null, ctx.row().id, 0, ctx.request);
    expect(ctx.row().imagePath).toBeTruthy();
    const result = await ctx.service.removeCellImage(null, ctx.row().id, 0);
    expect(result.cellImages).toEqual([]);
    expect(result.imagePath).toBeNull();
    expect(result.imageMimeType).toBeNull();
    expect(result.imageBytes).toBeNull();
  });

  it('round-trips legacy postback and message actions through layout', async () => {
    const ctx = setup();
    const actions = [
      { type: 'postback', data: 'intent=REGISTER', displayText: 'สมัคร' },
      { type: 'message', text: '3', label: 'แอดมิน' },
    ];
    const dto = ApplyRichMenuLayoutDto.schema.parse({
      cells: 2,
      buttons: actions.map((action) => ({ action })),
    });
    const result = await ctx.service.applyLayout(null, ctx.row().id, dto);
    expect(result.areas.map((area) => area.action)).toEqual(actions);
  });

  it('uses null regardless of the authenticated admin company', () => {
    expect(
      tenantOf({ admin: { companyId: 'future-company' } } as AdminRequest),
    ).toBeNull();
  });

  it('rejects assigning a company through admin creation', () => {
    expect(
      CreateAdminDto.schema.safeParse({
        username: 'owner2',
        password: 'password123',
        firstName: 'A',
        lastName: 'B',
        email: 'owner@example.com',
        phone: '0812345678',
        role: 'owner',
        companyId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(false);
  });
});

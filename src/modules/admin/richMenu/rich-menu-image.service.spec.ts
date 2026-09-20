import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { RichMenuImageService } from './rich-menu-image.service';

const CANVAS = { width: 2500, height: 1686 };

const solid = (width: number, height: number, rgb: [number, number, number]) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .png()
    .toBuffer();

describe('RichMenuImageService', () => {
  const service = new RichMenuImageService();

  it('resizes stored artwork again when the layout changes from six cells to one', async () => {
    const cell = await service.storeCell(
      await solid(100, 100, [255, 0, 0]),
      service.cellRects(6, 2500, 1686)[0],
    );
    try {
      const result = await service.composite(1, [cell], 2500, 1686);
      const pixel = await sharp(result.buffer)
        .extract({ left: 2000, top: 1000, width: 1, height: 1 })
        .raw()
        .toBuffer();
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(30);
      expect(pixel[2]).toBeLessThan(30);
    } finally {
      await service.removeCellImage(cell.path);
    }
  });

  it('tiles the canvas exactly, leaving no seam on the last column', () => {
    for (const cells of [1, 2, 3, 4, 6]) {
      const rects = service.cellRects(cells, CANVAS.width, CANVAS.height);

      expect(rects).toHaveLength(cells);

      const covered = rects.reduce(
        (total, rect) => total + rect.width * rect.height,
        0,
      );
      expect(covered).toBe(CANVAS.width * CANVAS.height);

      const right = Math.max(...rects.map((rect) => rect.x + rect.width));
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
      expect(right).toBe(CANVAS.width);
      expect(bottom).toBe(CANVAS.height);
    }
  });

  it('lays 6 cells out as three columns over two rows', () => {
    const rects = service.cellRects(6, CANVAS.width, CANVAS.height);

    expect(rects.slice(0, 3).every((rect) => rect.y === 0)).toBe(true);
    expect(rects.slice(3).every((rect) => rect.y === 843)).toBe(true);
    expect(rects.map((rect) => rect.x)).toEqual([0, 833, 1667, 0, 833, 1667]);
  });

  it('refuses a cell count LINE artwork cannot be divided into here', () => {
    expect(() => service.cellRects(5, CANVAS.width, CANVAS.height)).toThrow(
      BadRequestException,
    );
  });

  it('resizes an off-size upload to fill its cell without distorting it', async () => {
    const rect = service.cellRects(6, CANVAS.width, CANVAS.height)[0];
    const stored = await service.storeCell(
      await solid(400, 400, [255, 0, 0]),
      rect,
    );

    try {
      expect(stored).toMatchObject({
        index: 0,
        width: rect.width,
        height: rect.height,
        mimeType: 'image/png',
      });
    } finally {
      await service.removeCellImage(stored.path);
    }
  });

  it('composites each cell at its own rect and stays under the LINE 1MB cap', async () => {
    const rects = service.cellRects(2, CANVAS.width, CANVAS.height);
    const left = await service.storeCell(
      await solid(100, 100, [255, 0, 0]),
      rects[0],
    );
    const right = await service.storeCell(
      await solid(100, 100, [0, 0, 255]),
      rects[1],
    );

    try {
      const composited = await service.composite(
        2,
        [left, right],
        CANVAS.width,
        CANVAS.height,
      );

      expect(composited.buffer.length).toBeLessThanOrEqual(1024 * 1024);

      const image = sharp(composited.buffer);
      const meta = await image.metadata();
      expect(meta.width).toBe(CANVAS.width);
      expect(meta.height).toBe(CANVAS.height);

      // Sample one pixel per half: the red cell must not have bled right.
      const pixels = await image.raw().toBuffer();
      const channels = meta.channels ?? 3;
      const at = (x: number, y: number) => {
        const offset = (y * CANVAS.width + x) * channels;
        return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      };

      const [lr, , lb] = at(200, 800);
      const [rr, , rb] = at(2300, 800);
      expect(lr).toBeGreaterThan(lb);
      expect(rb).toBeGreaterThan(rr);
    } finally {
      await service.removeCellImages([left, right]);
    }
  });

  it('lays a half-filled menu out on the grid it declares, not on how many images exist', async () => {
    // Two uploads in a 6-cell menu must stay in cells 0 and 4, never be
    // re-read as a 2-cell menu and stretched across half the canvas each.
    const rects = service.cellRects(6, CANVAS.width, CANVAS.height);
    const first = await service.storeCell(
      await solid(60, 60, [0, 255, 0]),
      rects[0],
    );
    const fifth = await service.storeCell(
      await solid(60, 60, [0, 255, 0]),
      rects[4],
    );

    try {
      const composited = await service.composite(
        6,
        [first, fifth],
        CANVAS.width,
        CANVAS.height,
      );
      const meta = await sharp(composited.buffer).metadata();

      expect(meta.width).toBe(CANVAS.width);
      expect(meta.height).toBe(CANVAS.height);
      expect(first.width).toBe(rects[0].width);
      expect(fifth.height).toBe(rects[4].height);
    } finally {
      await service.removeCellImages([first, fifth]);
    }
  });

  it('refuses a stored path that is not one it wrote', async () => {
    await expect(
      service.composite(
        1,
        [
          {
            index: 0,
            path: '/uploads/richmenu/cells/../../../etc/passwd',
            mimeType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        ],
        CANVAS.width,
        CANVAS.height,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

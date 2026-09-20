import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  RICH_MENU_CELL_LAYOUTS,
  RICH_MENU_CELL_UPLOAD_URL_PREFIX,
  RICH_MENU_IMAGE_MAX_BYTES,
} from './rich-menu.constants';
import type { RichMenuCellImage } from './dto/rich-menu.dto';

const RICH_MENU_CELL_DIR = join(process.cwd(), 'uploads', 'richmenu', 'cells');

/** A cell grid covering the whole canvas, in the order a tenant fills it. */
export type CellRect = {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Turns the images a tenant uploads per button into the single image LINE
 * accepts for a menu.
 *
 * LINE takes exactly one image per rich menu, but tenants think in buttons, so
 * each cell is stored separately and composited on demand. Storing the parts
 * is what lets one button's artwork be replaced without re-uploading the rest.
 */
@Injectable()
export class RichMenuImageService {
  private readonly logger = new Logger(RichMenuImageService.name);

  /**
   * Edges are rounded one at a time rather than by rounding a cell width, so
   * the cells always tile the canvas exactly with no seam on the last column.
   */
  cellRects(cells: number, width: number, height: number): CellRect[] {
    const layout = RICH_MENU_CELL_LAYOUTS.find(
      (candidate) => candidate.cells === cells,
    );

    if (!layout) {
      throw new BadRequestException(
        `A menu can have ${RICH_MENU_CELL_LAYOUTS.map((l) => l.cells).join(
          ', ',
        )} cells, not ${cells}`,
      );
    }

    const edge = (index: number, count: number, total: number) =>
      Math.round((total * index) / count);

    const rects: CellRect[] = [];

    for (let row = 0; row < layout.rows; row += 1) {
      for (let column = 0; column < layout.columns; column += 1) {
        const x = edge(column, layout.columns, width);
        const y = edge(row, layout.rows, height);

        rects.push({
          index: rects.length,
          x,
          y,
          width: edge(column + 1, layout.columns, width) - x,
          height: edge(row + 1, layout.rows, height) - y,
        });
      }
    }

    return rects;
  }

  /**
   * Stores one cell's artwork, resized to fill its rect. `cover` crops rather
   * than distorts: a button drawn from a stretched photo looks broken, while a
   * cropped one just loses its edges.
   */
  async storeCell(image: Buffer, rect: CellRect): Promise<RichMenuCellImage> {
    const normalized = await sharp(image)
      .resize(rect.width, rect.height, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    await mkdir(RICH_MENU_CELL_DIR, { recursive: true });

    const filename = `${randomUUID()}.png`;
    await writeFile(join(RICH_MENU_CELL_DIR, filename), normalized);

    return {
      index: rect.index,
      path: `${RICH_MENU_CELL_UPLOAD_URL_PREFIX}/${filename}`,
      mimeType: 'image/png',
      bytes: normalized.length,
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * Flattens every stored cell onto one canvas. Cells with no upload yet stay
   * the background colour, so a half-filled menu still previews and publishes.
   *
   * JPEG quality steps down until the result fits LINE's 1MB cap; PNG can beat
   * JPEG on flat artwork, so whichever comes out smaller wins.
   */
  async composite(
    cellCount: number,
    cells: RichMenuCellImage[],
    width: number,
    height: number,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    // The grid comes from how many cells the menu declares, never from how
    // many images happen to be uploaded: a half-filled 6-cell menu must still
    // lay its images out on a 6-cell grid.
    const rects = this.cellRects(cellCount, width, height);

    const layers = await Promise.all(
      cells.map(async (cell) => {
        const rect = rects.find((candidate) => candidate.index === cell.index);

        if (!rect) {
          throw new BadRequestException(
            `Cell ${cell.index} does not exist in a ${cellCount}-cell menu`,
          );
        }

        return {
          input: await sharp(await this.readCell(cell.path))
            .resize(rect.width, rect.height, {
              fit: 'cover',
              position: 'centre',
            })
            .png()
            .toBuffer(),
          left: rect.x,
          top: rect.y,
        };
      }),
    );

    const canvas = sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).composite(layers);

    const png = await canvas.clone().png({ compressionLevel: 9 }).toBuffer();

    if (png.length <= RICH_MENU_IMAGE_MAX_BYTES) {
      const jpeg = await this.shrinkToLimit(canvas);
      return jpeg && jpeg.length < png.length
        ? { buffer: jpeg, mimeType: 'image/jpeg' }
        : { buffer: png, mimeType: 'image/png' };
    }

    const jpeg = await this.shrinkToLimit(canvas);

    if (!jpeg) {
      throw new BadRequestException(
        'The composited menu image cannot be squeezed under the 1MB LINE limit; use simpler artwork',
      );
    }

    return { buffer: jpeg, mimeType: 'image/jpeg' };
  }

  async removeCellImages(cells: RichMenuCellImage[]): Promise<void> {
    await Promise.all(cells.map((cell) => this.removeCellImage(cell.path)));
  }

  async removeCellImage(path: string | undefined): Promise<void> {
    if (!path?.startsWith(`${RICH_MENU_CELL_UPLOAD_URL_PREFIX}/`)) return;

    try {
      await unlink(join(RICH_MENU_CELL_DIR, this.filenameOf(path)));
    } catch {
      // Best-effort cleanup; a missing file is not an error.
    }
  }

  private async shrinkToLimit(canvas: sharp.Sharp): Promise<Buffer | null> {
    for (const quality of [90, 80, 70, 60, 50]) {
      const buffer = await canvas
        .clone()
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      if (buffer.length <= RICH_MENU_IMAGE_MAX_BYTES) return buffer;

      this.logger.debug(
        `Composited menu image is ${buffer.length} bytes at q${quality}; trying lower`,
      );
    }

    return null;
  }

  private async readCell(path: string): Promise<Buffer> {
    try {
      return await readFile(join(RICH_MENU_CELL_DIR, this.filenameOf(path)));
    } catch {
      throw new BadRequestException(
        `A stored cell image is missing (${path}); upload it again`,
      );
    }
  }

  /** Refuses anything but the flat uuid filenames `storeCell` writes. */
  private filenameOf(path: string): string {
    const filename = path.slice(RICH_MENU_CELL_UPLOAD_URL_PREFIX.length + 1);

    if (!/^[0-9a-f-]{36}\.png$/.test(filename)) {
      throw new BadRequestException('Invalid stored cell image path');
    }

    return filename;
  }
}

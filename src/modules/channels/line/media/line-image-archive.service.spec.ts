import type { PrismaService } from '../../../../prisma/prisma.service';
import type { FileStorageService } from '../../../../infra/storage/file-storage.service';
import type { LineService } from '../delivery/line-reply.service';
import {
  LINE_IMAGE_FOLDER,
  LineImageArchiveService,
} from './line-image-archive.service';

const jpeg = {
  mediaType: 'image/jpeg' as const,
  data: Buffer.from('jpg').toString('base64'),
};

function build(
  row: { id: string; mediaUrl: string | null } | null,
  won = true,
) {
  const prisma = {
    lineChatHistory: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: won ? 1 : 0 }),
    },
  };
  const storage = {
    upload: jest.fn().mockResolvedValue('/uploads/line/images/a.jpg'),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const line = { getImageContent: jest.fn().mockResolvedValue(jpeg) };
  const service = new LineImageArchiveService(
    prisma as unknown as PrismaService,
    storage as unknown as FileStorageService,
    line as unknown as LineService,
  );
  return { service, prisma, storage, line };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('LineImageArchiveService', () => {
  it('stores the image privately and records the reference on the message', async () => {
    const t = build({ id: 'h1', mediaUrl: null });

    await expect(
      t.service.store('m1', () => Promise.resolve(jpeg)),
    ).resolves.toBe('/uploads/line/images/a.jpg');

    expect(t.storage.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: 'private',
        folder: LINE_IMAGE_FOLDER,
        contentType: 'image/jpeg',
        extension: '.jpg',
        body: Buffer.from('jpg'),
      }),
    );
    expect(t.prisma.lineChatHistory.updateMany).toHaveBeenCalledWith({
      where: { id: 'h1', mediaUrl: null },
      data: { mediaUrl: '/uploads/line/images/a.jpg' },
    });
  });

  it('a redelivered event with a stored copy downloads and uploads nothing', async () => {
    const t = build({ id: 'h1', mediaUrl: '/uploads/line/images/old.jpg' });
    const load = jest.fn();

    await expect(t.service.store('m1', load)).resolves.toBe(
      '/uploads/line/images/old.jpg',
    );
    expect(load).not.toHaveBeenCalled();
    expect(t.storage.upload).not.toHaveBeenCalled();
  });

  it('losing a race removes its own file instead of leaving an orphan', async () => {
    const t = build({ id: 'h1', mediaUrl: null }, false);

    await expect(
      t.service.store('m1', () => Promise.resolve(jpeg)),
    ).resolves.toBeNull();
    expect(t.storage.remove).toHaveBeenCalledWith(
      '/uploads/line/images/a.jpg',
      LINE_IMAGE_FOLDER,
    );
  });

  it('no stored message → nothing is fetched', async () => {
    const t = build(null);
    await t.service.store('m1', t.line.getImageContent);
    expect(t.line.getImageContent).not.toHaveBeenCalled();
  });

  it('fetchAndKeep never throws into the turn, even when LINE or storage fails', async () => {
    const t = build({ id: 'h1', mediaUrl: null });
    t.line.getImageContent.mockRejectedValueOnce(new Error('LINE 404'));
    t.storage.upload.mockRejectedValueOnce(new Error('disk full'));

    expect(() => t.service.fetchAndKeep('m1')).not.toThrow();
    expect(() => t.service.fetchAndKeep('m2')).not.toThrow();
    await flush();
    await flush();
    expect(t.prisma.lineChatHistory.updateMany).not.toHaveBeenCalled();
  });

  it('fetchAndKeep downloads from LINE and stores the copy', async () => {
    const t = build({ id: 'h1', mediaUrl: null });
    t.service.fetchAndKeep('m1');
    await flush();
    await flush();
    expect(t.line.getImageContent).toHaveBeenCalledWith('m1');
    expect(t.storage.upload).toHaveBeenCalled();
  });
});

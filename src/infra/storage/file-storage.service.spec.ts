import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileStorageService } from './file-storage.service';
import {
  LOCAL_UPLOAD_ROOT,
  LocalObjectStorageAdapter,
} from './local-object-storage.adapter';
import { R2ObjectStorageAdapter } from './r2-object-storage.adapter';

const R2_ENV = {
  R2_ACCOUNT_ID: 'account',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'private-bucket',
  R2_PUBLIC_BUCKET: 'public-bucket',
  R2_PUBLIC_URL: 'https://files.example.com/',
};

function build(env: Record<string, string>) {
  const config = new ConfigService(env);
  const r2 = new R2ObjectStorageAdapter(config);
  const local = new LocalObjectStorageAdapter();
  return { service: new FileStorageService(config, r2, local), r2, local };
}

describe('FileStorageService', () => {
  it('defaults to the local driver and rejects an unknown one', () => {
    expect(build({}).service.driver).toBe('local');
    expect(build({ ...R2_ENV, STORAGE_DRIVER: 'r2' }).service.driver).toBe(
      'r2',
    );
    expect(() => build({ STORAGE_DRIVER: 's3' })).toThrow(/STORAGE_DRIVER/);
  });

  it('round-trips a local file and deletes it only from its own folder', async () => {
    const { service } = build({});
    const reference = await service.upload({
      visibility: 'public',
      folder: 'storage-spec',
      body: Buffer.from('hello'),
      contentType: 'text/plain',
      extension: '.txt',
    });
    const path = join(LOCAL_UPLOAD_ROOT, reference.slice('/uploads/'.length));

    try {
      expect(reference).toMatch(
        /^\/uploads\/storage-spec\/[0-9a-f-]{36}\.txt$/,
      );
      expect(await service.read(reference, 'storage-spec')).toEqual(
        Buffer.from('hello'),
      );
      // Another feature's folder neither reads nor deletes it.
      expect(await service.read(reference, 'admin')).toBeNull();
      await service.remove(reference, 'admin');
      expect(existsSync(path)).toBe(true);
      expect(await service.url(reference)).toBe(reference);
    } finally {
      await service.remove(reference, 'storage-spec');
    }

    expect(existsSync(path)).toBe(false);
    expect(await service.read(reference, 'storage-spec')).toBeNull();
  });

  it('accepts underscore folders and matches any of several folders', async () => {
    const { service } = build({});
    const reference = await service.upload({
      visibility: 'public',
      folder: 'admin_profile_image',
      body: Buffer.from('hi'),
      contentType: 'text/plain',
      extension: '.txt',
    });

    try {
      expect(reference).toMatch(/^\/uploads\/admin_profile_image\//);
      expect(
        await service.read(reference, ['admin_profile_image', 'admin']),
      ).toEqual(Buffer.from('hi'));
      expect(await service.read(reference, ['admin'])).toBeNull();
    } finally {
      await service.remove(reference, ['admin', 'admin_profile_image']);
    }

    expect(await service.read(reference, 'admin_profile_image')).toBeNull();
  });

  it('refuses crafted references and passes foreign URLs through', async () => {
    const { service } = build({});

    expect(
      await service.read('/uploads/richmenu/cells/../../../etc/passwd', 'x'),
    ).toBeNull();
    expect(
      await service.read('https://evil.example/a.png', 'admin'),
    ).toBeNull();
    expect(await service.url('https://cdn.example/a.png')).toBe(
      'https://cdn.example/a.png',
    );
    expect(await service.url(null)).toBeNull();
  });

  it('writes to R2 but still serves legacy /uploads rows from disk', async () => {
    const { service, r2 } = build({ ...R2_ENV, STORAGE_DRIVER: 'r2' });
    const put = jest
      .spyOn(r2, 'put')
      .mockResolvedValue('https://files.example.com/admin/a.png');

    await expect(
      service.upload({
        visibility: 'public',
        folder: 'admin',
        body: Buffer.from('x'),
        contentType: 'image/png',
        extension: '.png',
      }),
    ).resolves.toBe('https://files.example.com/admin/a.png');
    const [written] = put.mock.calls[0];
    expect(written.visibility).toBe('public');
    expect(written.key).toMatch(/^admin\/[0-9a-f-]{36}\.png$/);

    expect(await service.url('/uploads/admin/old.png')).toBe(
      '/uploads/admin/old.png',
    );
  });

  it('hides provider errors behind a generic 502', async () => {
    const { service, r2 } = build({ ...R2_ENV, STORAGE_DRIVER: 'r2' });
    jest
      .spyOn(r2, 'put')
      .mockRejectedValue(new Error('AccessDenied on bucket private-bucket'));

    const upload = service.upload({
      visibility: 'private',
      folder: 'billing',
      body: Buffer.from('x'),
      contentType: 'image/png',
      extension: '.png',
    });

    await expect(upload).rejects.toBeInstanceOf(BadGatewayException);
    await expect(upload).rejects.not.toThrow(/private-bucket/);
  });

  it('swallows delete failures', async () => {
    const { service, r2 } = build({ ...R2_ENV, STORAGE_DRIVER: 'r2' });
    jest.spyOn(r2, 'delete').mockRejectedValue(new Error('network down'));

    await expect(
      service.remove('r2-private:billing/a.png', 'billing'),
    ).resolves.toBeUndefined();
  });
});

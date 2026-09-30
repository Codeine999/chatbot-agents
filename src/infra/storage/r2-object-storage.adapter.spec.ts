import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { R2ObjectStorageAdapter } from './r2-object-storage.adapter';

const R2_ENV = {
  R2_ACCOUNT_ID: 'account',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'private-bucket',
  R2_PUBLIC_BUCKET: 'public-bucket',
  R2_PUBLIC_URL: 'https://files.example.com/',
};

describe('R2ObjectStorageAdapter', () => {
  // Every call is stubbed: this spec never reaches Cloudflare.
  const send = jest.spyOn(S3Client.prototype, 'send');

  afterEach(() => send.mockReset());

  it('puts public and private objects into their own buckets', async () => {
    send.mockResolvedValue({} as never);
    const adapter = new R2ObjectStorageAdapter(new ConfigService(R2_ENV));

    await expect(
      adapter.put({
        visibility: 'public',
        key: 'admin/a.png',
        body: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).resolves.toBe('https://files.example.com/admin/a.png');
    await expect(
      adapter.put({
        visibility: 'private',
        key: 'billing/b.png',
        body: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).resolves.toBe('r2-private:billing/b.png');

    const [publicPut, privatePut] = send.mock.calls.map(
      ([command]) => (command as PutObjectCommand).input,
    );
    expect(publicPut).toMatchObject({
      Bucket: 'public-bucket',
      Key: 'admin/a.png',
      ContentType: 'image/png',
    });
    expect(privatePut).toMatchObject({
      Bucket: 'private-bucket',
      Key: 'billing/b.png',
      CacheControl: 'private, no-store',
    });
  });

  it('locates only references it produced', () => {
    const adapter = new R2ObjectStorageAdapter(new ConfigService(R2_ENV));

    expect(adapter.locate('https://files.example.com/admin/a.png')).toEqual({
      visibility: 'public',
      key: 'admin/a.png',
    });
    expect(adapter.locate('r2-private:billing/b.png')).toEqual({
      visibility: 'private',
      key: 'billing/b.png',
    });
    expect(adapter.locate('r2-private:billing/../x.png')).toBeNull();
    expect(adapter.locate('https://other.example.com/admin/a.png')).toBeNull();
    expect(adapter.locate('/uploads/admin/a.png')).toBeNull();
  });

  it('signs private URLs without a network call and never signs public ones', async () => {
    const adapter = new R2ObjectStorageAdapter(
      new ConfigService({ ...R2_ENV, R2_SIGNED_URL_TTL_SECONDS: '60' }),
    );

    const signed = new URL(
      await adapter.url({ visibility: 'private', key: 'billing/b.png' }),
    );
    expect(signed.host).toBe('private-bucket.account.r2.cloudflarestorage.com');
    expect(signed.pathname).toBe('/billing/b.png');
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('60');

    await expect(
      adapter.url({ visibility: 'public', key: 'admin/a.png' }),
    ).resolves.toBe('https://files.example.com/admin/a.png');
    expect(send).not.toHaveBeenCalled();
  });

  it('reads bytes and maps a missing key to null', async () => {
    const adapter = new R2ObjectStorageAdapter(new ConfigService(R2_ENV));
    send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: () => Promise.resolve(Uint8Array.of(1, 2)),
      },
    } as never);
    send.mockRejectedValueOnce(
      new NoSuchKey({ message: 'missing', $metadata: {} }) as never,
    );

    await expect(
      adapter.get({ visibility: 'public', key: 'admin/a.png' }),
    ).resolves.toEqual(Buffer.from([1, 2]));
    await expect(
      adapter.get({ visibility: 'private', key: 'billing/gone.png' }),
    ).resolves.toBeNull();
    expect((send.mock.calls[1][0] as GetObjectCommand).input.Bucket).toBe(
      'private-bucket',
    );
  });

  it('refuses to run without credentials or a public bucket', async () => {
    const unconfigured = new R2ObjectStorageAdapter(new ConfigService({}));
    await expect(
      unconfigured.get({ visibility: 'private', key: 'billing/a.png' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const privateOnly = new R2ObjectStorageAdapter(
      new ConfigService({
        ...R2_ENV,
        R2_PUBLIC_BUCKET: '',
        R2_PUBLIC_URL: '',
      }),
    );
    await expect(
      privateOnly.put({
        visibility: 'public',
        key: 'admin/a.png',
        body: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(send).not.toHaveBeenCalled();
  });
});

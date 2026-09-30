import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isSafeObjectKey,
  type ObjectStorageAdapter,
  type PutObjectInput,
  type StorageVisibility,
  type StoredObjectLocation,
} from './object-storage.types';

/** Reference prefix for objects in the private bucket, which have no public URL. */
export const R2_PRIVATE_REFERENCE_PREFIX = 'r2-private:';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;
/** S3 signature v4, which R2 implements, rejects anything longer than 7 days. */
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

type R2Settings = Readonly<{
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  privateBucket: string;
  publicBucket?: string;
  publicUrl?: string;
  signedUrlTtlSeconds: number;
}>;

/**
 * Cloudflare R2 through its S3-compatible API.
 *
 * R2 grants public access per bucket, not per object, so public and private
 * files need two buckets: `R2_PUBLIC_BUCKET` has a public domain
 * (`R2_PUBLIC_URL`, an r2.dev or custom domain) and `R2_BUCKET` has none.
 *
 * Settings are read on use, not at boot, so the app still starts without R2
 * credentials while the `local` driver is selected.
 */
@Injectable()
export class R2ObjectStorageAdapter implements ObjectStorageAdapter {
  readonly driver = 'r2' as const;

  private client?: S3Client;

  constructor(private readonly config: ConfigService) {}

  async put(input: PutObjectInput): Promise<string> {
    const settings = this.settings();

    await this.getClient(settings).send(
      new PutObjectCommand({
        Bucket: this.bucketFor(input.visibility, settings),
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Keys are random and never overwritten, so a public object can be
        // cached forever. A private one must not be kept by shared caches.
        CacheControl:
          input.visibility === 'public'
            ? 'public, max-age=31536000, immutable'
            : 'private, no-store',
      }),
    );

    return input.visibility === 'public'
      ? `${this.publicUrlOf(settings)}/${input.key}`
      : `${R2_PRIVATE_REFERENCE_PREFIX}${input.key}`;
  }

  locate(reference: string): StoredObjectLocation | null {
    if (reference.startsWith(R2_PRIVATE_REFERENCE_PREFIX)) {
      const key = reference.slice(R2_PRIVATE_REFERENCE_PREFIX.length);
      return isSafeObjectKey(key) ? { visibility: 'private', key } : null;
    }

    const publicUrl = this.trimmed('R2_PUBLIC_URL')?.replace(/\/+$/, '');
    if (!publicUrl || !reference.startsWith(`${publicUrl}/`)) return null;

    const key = reference.slice(publicUrl.length + 1);
    return isSafeObjectKey(key) ? { visibility: 'public', key } : null;
  }

  async get(location: StoredObjectLocation): Promise<Buffer | null> {
    const settings = this.settings();

    try {
      const response = await this.getClient(settings).send(
        new GetObjectCommand({
          Bucket: this.bucketFor(location.visibility, settings),
          Key: location.key,
        }),
      );

      if (!response.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(location: StoredObjectLocation): Promise<void> {
    const settings = this.settings();

    // S3 DeleteObject succeeds for a missing key, so this is idempotent.
    await this.getClient(settings).send(
      new DeleteObjectCommand({
        Bucket: this.bucketFor(location.visibility, settings),
        Key: location.key,
      }),
    );
  }

  async url(location: StoredObjectLocation): Promise<string> {
    const settings = this.settings();

    if (location.visibility === 'public') {
      return `${this.publicUrlOf(settings)}/${location.key}`;
    }

    return getSignedUrl(
      this.getClient(settings),
      new GetObjectCommand({
        Bucket: settings.privateBucket,
        Key: location.key,
      }),
      { expiresIn: settings.signedUrlTtlSeconds },
    );
  }

  private settings(): R2Settings {
    const accountId = this.trimmed('R2_ACCOUNT_ID');
    const accessKeyId = this.trimmed('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.trimmed('R2_SECRET_ACCESS_KEY');
    const privateBucket = this.trimmed('R2_BUCKET');

    if (!accountId || !accessKeyId || !secretAccessKey || !privateBucket) {
      throw new ServiceUnavailableException('File storage is not configured');
    }

    const configuredTtl = Number(
      this.config.get<string>('R2_SIGNED_URL_TTL_SECONDS') ??
        DEFAULT_SIGNED_URL_TTL_SECONDS,
    );

    return {
      accountId,
      accessKeyId,
      secretAccessKey,
      privateBucket,
      publicBucket: this.trimmed('R2_PUBLIC_BUCKET'),
      publicUrl: this.trimmed('R2_PUBLIC_URL')?.replace(/\/+$/, ''),
      signedUrlTtlSeconds:
        Number.isInteger(configuredTtl) &&
        configuredTtl > 0 &&
        configuredTtl <= MAX_SIGNED_URL_TTL_SECONDS
          ? configuredTtl
          : DEFAULT_SIGNED_URL_TTL_SECONDS,
    };
  }

  private bucketFor(
    visibility: StorageVisibility,
    settings: R2Settings,
  ): string {
    if (visibility === 'private') return settings.privateBucket;

    if (!settings.publicBucket || !settings.publicUrl) {
      throw new ServiceUnavailableException(
        'Public file storage is not configured',
      );
    }

    return settings.publicBucket;
  }

  private publicUrlOf(settings: R2Settings): string {
    if (!settings.publicUrl) {
      throw new ServiceUnavailableException(
        'Public file storage is not configured',
      );
    }

    return settings.publicUrl;
  }

  private getClient(settings: R2Settings): S3Client {
    this.client ??= new S3Client({
      region: 'auto',
      endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      },
    });

    return this.client;
  }

  private trimmed(name: string): string | undefined {
    return this.config.get<string>(name)?.trim() || undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)
  );
}

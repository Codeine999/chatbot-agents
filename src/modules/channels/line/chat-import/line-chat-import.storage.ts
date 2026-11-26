import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isSafeObjectKey } from '../../../../infra/storage/object-storage.types';
import { LINE_IMPORT_KEY_PREFIX } from './line-chat-import.config';

const UPLOAD_URL_TTL_SECONDS = 60 * 60;

/** `line-imports/<uuid>.zip` — the only keys this service ever touches. */
export function importObjectKey(batchId: string): string {
  return `${LINE_IMPORT_KEY_PREFIX}/${batchId}.zip`;
}

function assertImportKey(key: string): void {
  if (!key.startsWith(`${LINE_IMPORT_KEY_PREFIX}/`) || !isSafeObjectKey(key)) {
    throw new Error(`Refusing to touch a non-import object: ${key}`);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata.httpStatusCode === 404)
  );
}

/**
 * Backup zips in the private R2 bucket. The browser uploads straight to R2
 * through presigned URLs (the zip can be gigabytes, so it never passes
 * through Fastify), and the worker streams it back to a local file.
 *
 * It has its own S3 client: the shared adapter has a 20 s request timeout and
 * reads whole objects into memory, which a multi-gigabyte zip cannot survive.
 * The bucket needs a CORS rule allowing PUT from the admin origin and
 * exposing the ETag header (multipart completion needs it).
 */
@Injectable()
export class LineChatImportStorage {
  private client?: S3Client;

  constructor(private readonly config: ConfigService) {}

  /** The import needs R2: the default `local` driver has no presigned uploads. */
  assertAvailable(): void {
    const driver = this.config.get<string>('STORAGE_DRIVER')?.trim() || 'local';
    if (driver !== 'r2') {
      throw new ConflictException({
        code: 'IMPORT_REQUIRES_R2',
        message: 'LINE chat import needs STORAGE_DRIVER=r2',
      });
    }
    this.settings();
  }

  async presignPut(key: string, size: number): Promise<string> {
    assertImportKey(key);
    const { bucket } = this.settings();
    return getSignedUrl(
      this.getClient(),
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentLength: size,
        ContentType: 'application/zip',
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  }

  async startMultipart(key: string): Promise<string> {
    assertImportKey(key);
    const { bucket } = this.settings();
    const result = await this.getClient().send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'application/zip',
      }),
    );
    if (!result.UploadId)
      throw new ServiceUnavailableException('Storage did not start the upload');
    return result.UploadId;
  }

  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    assertImportKey(key);
    const { bucket } = this.settings();
    return getSignedUrl(
      this.getClient(),
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<Readonly<{ partNumber: number; etag: string }>>,
  ): Promise<void> {
    assertImportKey(key);
    const { bucket } = this.settings();
    await this.getClient().send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    assertImportKey(key);
    const { bucket } = this.settings();
    await this.getClient()
      .send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      )
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
  }

  /** Stored size, or null when the object does not exist. */
  async size(key: string): Promise<number | null> {
    assertImportKey(key);
    const { bucket } = this.settings();
    try {
      const head = await this.getClient().send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return head.ContentLength ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Streams the object to `path` without holding it in memory. */
  async download(key: string, path: string): Promise<void> {
    assertImportKey(key);
    const { bucket } = this.settings();
    const result = await this.getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!result.Body) throw new Error('Import object has no body');
    await mkdir(dirname(path), { recursive: true });
    try {
      await pipeline(result.Body as Readable, createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertImportKey(key);
    const { bucket } = this.settings();
    await this.getClient().send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  private settings() {
    const get = (name: string) =>
      this.config.get<string>(name)?.trim() || undefined;
    const accountId = get('R2_ACCOUNT_ID');
    const accessKeyId = get('R2_ACCESS_KEY_ID');
    const secretAccessKey = get('R2_SECRET_ACCESS_KEY');
    const bucket = get('R2_BUCKET');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new ServiceUnavailableException('File storage is not configured');
    }
    return { accountId, accessKeyId, secretAccessKey, bucket };
  }

  private getClient(): S3Client {
    if (this.client) return this.client;
    const { accountId, accessKeyId, secretAccessKey } = this.settings();
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // No request timeout: a download of several gigabytes takes minutes.
      requestHandler: { connectionTimeout: 10_000 },
    });
    return this.client;
  }
}

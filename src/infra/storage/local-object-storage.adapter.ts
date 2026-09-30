import { Injectable } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isSafeObjectKey,
  type ObjectStorageAdapter,
  type PutObjectInput,
  type StoredObjectLocation,
} from './object-storage.types';

/** Directory `main.ts` serves statically, and the URL prefix it serves it at. */
export const LOCAL_UPLOAD_ROOT = join(process.cwd(), 'uploads');
export const LOCAL_UPLOAD_URL_PREFIX = '/uploads';

/**
 * Disk storage under `uploads/`, served by `@fastify/static`.
 *
 * It is the development driver, and it keeps every row written before R2
 * existed readable and deletable. It has no private area: a `private` object
 * is served from `/uploads` like any other, exactly as uploads behaved before
 * this module. Use the `r2` driver wherever slips must stay private.
 */
@Injectable()
export class LocalObjectStorageAdapter implements ObjectStorageAdapter {
  readonly driver = 'local' as const;

  async put(input: PutObjectInput): Promise<string> {
    const path = this.pathOf(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);

    return `${LOCAL_UPLOAD_URL_PREFIX}/${input.key}`;
  }

  locate(reference: string): StoredObjectLocation | null {
    if (!reference.startsWith(`${LOCAL_UPLOAD_URL_PREFIX}/`)) return null;

    const key = reference.slice(LOCAL_UPLOAD_URL_PREFIX.length + 1);
    return isSafeObjectKey(key) ? { visibility: 'public', key } : null;
  }

  async get(location: StoredObjectLocation): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(location.key));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async delete(location: StoredObjectLocation): Promise<void> {
    try {
      await unlink(this.pathOf(location.key));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  url(location: StoredObjectLocation): Promise<string> {
    return Promise.resolve(`${LOCAL_UPLOAD_URL_PREFIX}/${location.key}`);
  }

  private pathOf(key: string): string {
    // `FileStorageService` builds keys and `locate` re-checks stored ones, so
    // this is a last line of defence rather than the validation itself.
    if (!isSafeObjectKey(key)) throw new Error(`Unsafe object key: ${key}`);
    return join(LOCAL_UPLOAD_ROOT, key);
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

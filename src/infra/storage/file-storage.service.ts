import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { LocalObjectStorageAdapter } from './local-object-storage.adapter';
import {
  isSafeObjectFolder,
  STORAGE_DRIVERS,
  type ObjectStorageAdapter,
  type StorageDriver,
  type StorageVisibility,
  type StoredObjectLocation,
} from './object-storage.types';
import { R2ObjectStorageAdapter } from './r2-object-storage.adapter';

export type UploadFileInput = Readonly<{
  visibility: StorageVisibility;
  /** Lowercase path such as `admin` or `richmenu/cells`. */
  folder: string;
  body: Buffer;
  contentType: string;
  /** Including the dot, e.g. `.png`. */
  extension: string;
}>;

/** One folder, or the current one plus names it was stored under before. */
export type StorageFolders = string | readonly string[];

type Located = Readonly<{
  adapter: ObjectStorageAdapter;
  location: StoredObjectLocation;
}>;

const EXTENSION = /^\.[a-z0-9]+$/;

/**
 * The one entry point features use for uploaded files.
 *
 * New files go to the driver chosen by `STORAGE_DRIVER` (`local` or `r2`).
 * Reads, deletes and URLs follow the reference instead, so files written by
 * the other driver — every `/uploads/...` row from before R2 — keep working.
 *
 * These are network calls under the `r2` driver: never call them inside a
 * database transaction.
 */
@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly writer: ObjectStorageAdapter;
  private readonly adapters: readonly ObjectStorageAdapter[];

  constructor(
    config: ConfigService,
    r2: R2ObjectStorageAdapter,
    local: LocalObjectStorageAdapter,
  ) {
    const driver = (config.get<string>('STORAGE_DRIVER')?.trim() ||
      'local') as StorageDriver;

    if (!STORAGE_DRIVERS.includes(driver)) {
      throw new Error(
        `STORAGE_DRIVER must be one of: ${STORAGE_DRIVERS.join(', ')}`,
      );
    }

    this.writer = driver === 'r2' ? r2 : local;
    this.adapters = [r2, local];
  }

  get driver(): StorageDriver {
    return this.writer.driver;
  }

  /** Stores a new file under a random name and returns the reference to persist. */
  async upload(input: UploadFileInput): Promise<string> {
    if (!isSafeObjectFolder(input.folder) || !EXTENSION.test(input.extension)) {
      throw new Error(
        `Invalid storage folder/extension: ${input.folder} ${input.extension}`,
      );
    }

    try {
      return await this.writer.put({
        visibility: input.visibility,
        key: `${input.folder}/${randomUUID()}${input.extension}`,
        body: input.body,
        contentType: input.contentType,
      });
    } catch (error) {
      throw this.toClientError('store', error);
    }
  }

  /**
   * The file's bytes, or null when the reference is not one this service wrote
   * into `folder`, or the file is gone. A feature that renamed its folder
   * passes the old name too, so rows written before the rename still resolve.
   */
  async read(
    reference: string | null | undefined,
    folder: StorageFolders,
  ): Promise<Buffer | null> {
    const located = this.locate(reference, folder);
    if (!located) return null;

    try {
      return await located.adapter.get(located.location);
    } catch (error) {
      throw this.toClientError('read', error);
    }
  }

  /**
   * Best-effort cleanup of a replaced or orphaned file. Never throws: a file
   * left behind is garbage, while a failed request after the database already
   * changed would be a lie to the caller.
   *
   * Only files directly in `folder` are deleted, so a reference copied from
   * another feature (a company logo set as a profile picture) is left alone.
   */
  async remove(
    reference: string | null | undefined,
    folder: StorageFolders,
  ): Promise<void> {
    const located = this.locate(reference, folder);
    if (!located) return;

    try {
      await located.adapter.delete(located.location);
    } catch (error) {
      this.logger.warn(
        `Could not delete stored file ${located.adapter.driver}:${located.location.key}: ${String(error)}`,
      );
    }
  }

  /**
   * What an API response should carry for a stored reference: the public URL,
   * a freshly signed URL for a private file, or the value unchanged when it is
   * not a reference this service owns (an external URL, for example).
   */
  async url(reference: string | null | undefined): Promise<string | null> {
    if (!reference) return null;

    const located = this.locate(reference);
    if (!located) return reference;

    try {
      return await located.adapter.url(located.location);
    } catch (error) {
      throw this.toClientError('sign', error);
    }
  }

  private locate(
    reference: string | null | undefined,
    folder?: StorageFolders,
  ): Located | null {
    if (!reference) return null;

    const folders = typeof folder === 'string' ? [folder] : folder;

    for (const adapter of this.adapters) {
      const location = adapter.locate(reference);
      if (!location) continue;
      if (
        folders !== undefined &&
        !folders.some((name) => isDirectlyIn(location.key, name))
      ) {
        return null;
      }
      return { adapter, location };
    }

    return null;
  }

  /** Keeps provider errors (bucket names, request ids) out of API responses. */
  private toClientError(action: string, error: unknown): HttpException {
    if (error instanceof HttpException) return error;

    this.logger.error(
      `File storage ${action} failed on ${this.writer.driver}: ${String(error)}`,
    );
    return new BadGatewayException('File storage is unavailable');
  }
}

function isDirectlyIn(key: string, folder: string): boolean {
  return key.slice(0, key.lastIndexOf('/')) === folder;
}

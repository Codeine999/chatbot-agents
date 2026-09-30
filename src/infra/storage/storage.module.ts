import { Module } from '@nestjs/common';
import { FileStorageService } from './file-storage.service';
import { LocalObjectStorageAdapter } from './local-object-storage.adapter';
import { R2ObjectStorageAdapter } from './r2-object-storage.adapter';

/**
 * File storage for uploads. Only `FileStorageService` is exported: features
 * store references, never talk to a bucket or the disk themselves.
 */
@Module({
  providers: [
    R2ObjectStorageAdapter,
    LocalObjectStorageAdapter,
    FileStorageService,
  ],
  exports: [FileStorageService],
})
export class StorageModule {}

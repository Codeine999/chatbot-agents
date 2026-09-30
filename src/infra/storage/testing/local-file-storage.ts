import { ConfigService } from '@nestjs/config';
import { FileStorageService } from '../file-storage.service';
import { LocalObjectStorageAdapter } from '../local-object-storage.adapter';
import { R2ObjectStorageAdapter } from '../r2-object-storage.adapter';

/** A `FileStorageService` on the local driver, for specs that touch real files. */
export function createLocalFileStorage(): FileStorageService {
  const config = new ConfigService({ STORAGE_DRIVER: 'local' });

  return new FileStorageService(
    config,
    new R2ObjectStorageAdapter(config),
    new LocalObjectStorageAdapter(),
  );
}

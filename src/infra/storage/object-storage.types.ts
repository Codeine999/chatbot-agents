/**
 * `public` objects are served from a public URL anyone can open (logos,
 * profile pictures, rich menu art). `private` objects are only reachable
 * through a short-lived signed URL (payment slips).
 */
export type StorageVisibility = 'public' | 'private';

export const STORAGE_DRIVERS = ['local', 'r2'] as const;

export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** Where one stored object lives inside the adapter that owns it. */
export type StoredObjectLocation = Readonly<{
  visibility: StorageVisibility;
  key: string;
}>;

export type PutObjectInput = StoredObjectLocation &
  Readonly<{
    body: Buffer;
    contentType: string;
  }>;

/**
 * One storage backend. Features never talk to an adapter directly; they go
 * through `FileStorageService`, which picks the adapter that owns a reference.
 *
 * A *reference* is the string persisted in the database, e.g.
 * `/uploads/admin/<uuid>.png` or `https://files.example.com/admin/<uuid>.png`.
 * Each adapter only recognises references it could have produced, so rows
 * written before a driver switch keep working.
 */
export interface ObjectStorageAdapter {
  readonly driver: StorageDriver;
  /** Stores the object and returns the reference to persist. */
  put(input: PutObjectInput): Promise<string>;
  /** The location behind `reference`, or null when this adapter did not write it. */
  locate(reference: string): StoredObjectLocation | null;
  /** The object's bytes, or null when it no longer exists. */
  get(location: StoredObjectLocation): Promise<Buffer | null>;
  /** Deleting a missing object is not an error. */
  delete(location: StoredObjectLocation): Promise<void>;
  /** A URL a browser can open: public URL, or a signed one for private objects. */
  url(location: StoredObjectLocation): Promise<string>;
}

/**
 * Object keys are `<folder>/<name>.<ext>` built from lowercase folder
 * segments. Dots are only allowed before the extension, so `..` can never
 * appear and a reference read back from the database cannot escape its root.
 */
const OBJECT_KEY = /^(?:[a-z0-9][a-z0-9_-]*\/)+[A-Za-z0-9_-]+\.[a-z0-9]+$/;

export function isSafeObjectKey(key: string): boolean {
  return OBJECT_KEY.test(key);
}

const FOLDER = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

export function isSafeObjectFolder(folder: string): boolean {
  return FOLDER.test(folder);
}

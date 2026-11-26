import type { Readable } from 'node:stream';
import * as yauzl from 'yauzl';

/**
 * Streams the CSV entries of a backup zip one at a time, from a local file.
 *
 * Nothing in the zip is ever written to disk under its own name: each entry
 * is read as a stream, so `../` or absolute names cannot escape anywhere.
 * Limits are checked from the central directory before reading, and yauzl
 * validates that an entry really inflates to the size it declares, so a
 * lying zip bomb fails instead of filling memory.
 */

export type ZipLimits = Readonly<{
  maxEntries: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
  /** Highest uncompressed/compressed ratio accepted for one entry. */
  maxRatio: number;
}>;

export type ZipCsvEntry = Readonly<{
  /** Position among the zip's CSV entries (stable across runs: the parse checkpoint). */
  index: number;
  fileName: string;
  uncompressedSize: number;
}>;

export class ZipLimitError extends Error {
  constructor(
    readonly reason:
      | 'TOO_MANY_ENTRIES'
      | 'TOO_LARGE'
      | 'SUSPICIOUS_RATIO'
      | 'NO_CSV',
  ) {
    super(`Zip rejected: ${reason}`);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Zip names are UTF-8 when the flag is set; LINE may omit it, so try UTF-8 first. */
function decodeName(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw;
  try {
    return utf8.decode(raw);
  } catch {
    return raw.toString('latin1');
  }
}

function isCsvName(name: string): boolean {
  const base = name.split('/').pop() ?? '';
  return (
    /\.csv$/i.test(base) &&
    !name.endsWith('/') &&
    !base.startsWith('._') && // macOS resource forks
    !name.startsWith('__MACOSX/')
  );
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: false,
        validateEntrySizes: true,
        strictFileNames: false,
      },
      (error, zip) =>
        error || !zip
          ? reject(error ?? new Error('Cannot open zip'))
          : resolve(zip),
    );
  });
}

function listEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function openStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) =>
      error || !stream
        ? reject(error ?? new Error('Cannot read entry'))
        : resolve(stream),
    );
  });
}

export class LineChatZipReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly entries: ReadonlyArray<
      Readonly<{ entry: yauzl.Entry; info: ZipCsvEntry }>
    >,
  ) {}

  /** Opens and validates the whole central directory before any entry is read. */
  static async open(
    path: string,
    limits: ZipLimits,
  ): Promise<LineChatZipReader> {
    const zip = await openZip(path);
    try {
      const all = await listEntries(zip);
      if (all.length > limits.maxEntries)
        throw new ZipLimitError('TOO_MANY_ENTRIES');

      let total = 0;
      const csv: Array<{ entry: yauzl.Entry; info: ZipCsvEntry }> = [];
      for (const entry of all) {
        const fileName = decodeName(entry.fileName);
        if (!isCsvName(fileName)) continue;
        if (entry.uncompressedSize > limits.maxEntryBytes)
          throw new ZipLimitError('TOO_LARGE');
        if (
          entry.compressedSize > 0 &&
          entry.uncompressedSize / entry.compressedSize > limits.maxRatio &&
          entry.uncompressedSize > 1024 * 1024
        ) {
          throw new ZipLimitError('SUSPICIOUS_RATIO');
        }
        total += entry.uncompressedSize;
        if (total > limits.maxUncompressedBytes)
          throw new ZipLimitError('TOO_LARGE');
        csv.push({
          entry,
          info: {
            index: csv.length,
            fileName,
            uncompressedSize: entry.uncompressedSize,
          },
        });
      }
      if (csv.length === 0) throw new ZipLimitError('NO_CSV');

      return new LineChatZipReader(zip, csv);
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  get count(): number {
    return this.entries.length;
  }

  info(index: number): ZipCsvEntry {
    return this.entries[index].info;
  }

  stream(index: number): Promise<Readable> {
    return openStream(this.zip, this.entries[index].entry);
  }

  close(): void {
    this.zip.close();
  }
}

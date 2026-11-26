import type { ConfigService } from '@nestjs/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LINE_CHAT_IMPORT_QUEUE = 'line-chat-import';

/** Folder of every import object in the private bucket. */
export const LINE_IMPORT_KEY_PREFIX = 'line-imports';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export type LineChatImportSettings = Readonly<{
  enabled: boolean;
  maxZipBytes: number;
  maxEntries: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
  /** Above this, the browser uploads in parts (S3 multipart). */
  multipartThresholdBytes: number;
  partSizeBytes: number;
  tmpDir: string;
  profileRps: number;
  stagingRetentionDays: number;
  /** Offset of the times written in the backup. Asia/Bangkok has no DST. */
  utcOffsetMinutes: number;
  /** Extra header names, merged over the built-in aliases (JSON object of arrays). */
  columnAliases: Partial<Record<LineCsvColumn, string[]>>;
}>;

export type LineCsvColumn =
  | 'senderType'
  | 'senderName'
  | 'date'
  | 'time'
  | 'datetime'
  | 'content';

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAliases(
  raw: string | undefined,
): LineChatImportSettings['columnAliases'] {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const result: Partial<Record<LineCsvColumn, string[]>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        result[key as LineCsvColumn] = value.filter(
          (item): item is string => typeof item === 'string',
        );
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function lineChatImportSettings(
  config: ConfigService,
): LineChatImportSettings {
  const get = (name: string) => config.get<string>(name);
  // Blank counts as unset: Number('') is 0, which would silently mean UTC.
  const offsetRaw = get('LINE_IMPORT_UTC_OFFSET_MINUTES')?.trim();
  const offset = offsetRaw ? Number(offsetRaw) : 420;

  return {
    enabled: get('LINE_IMPORT_ENABLED') === 'true',
    maxZipBytes: positiveNumber(get('LINE_IMPORT_MAX_ZIP_BYTES'), 5 * GB),
    maxEntries: positiveNumber(get('LINE_IMPORT_MAX_ENTRIES'), 200_000),
    maxUncompressedBytes: positiveNumber(
      get('LINE_IMPORT_MAX_UNCOMPRESSED_BYTES'),
      20 * GB,
    ),
    maxEntryBytes: positiveNumber(get('LINE_IMPORT_MAX_ENTRY_BYTES'), 200 * MB),
    multipartThresholdBytes: 100 * MB,
    partSizeBytes: 64 * MB,
    tmpDir: get('LINE_IMPORT_TMP_DIR')?.trim() || join(tmpdir(), 'line-import'),
    profileRps: positiveNumber(get('LINE_IMPORT_PROFILE_RPS'), 10),
    stagingRetentionDays: positiveNumber(
      get('LINE_IMPORT_STAGING_RETENTION_DAYS'),
      180,
    ),
    utcOffsetMinutes: Number.isFinite(offset) ? offset : 420,
    columnAliases: parseAliases(get('LINE_IMPORT_COLUMN_ALIASES')),
  };
}

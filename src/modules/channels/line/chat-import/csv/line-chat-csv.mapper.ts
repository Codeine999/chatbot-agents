import { createHash } from 'node:crypto';
import type { LineCsvColumn } from '../line-chat-import.config';

/**
 * Turns the records of ONE backup CSV (one customer) into staged messages.
 *
 * The real LINE OA backup layout is not documented anywhere we could read
 * (docs/line-chat-import-plan.md §1), so nothing here assumes a fixed line or
 * column position: the header row is found by matching known column names
 * (several languages, plus `LINE_IMPORT_COLUMN_ALIASES`), metadata lines
 * before it are ignored, and a row that cannot be read is counted and skipped
 * instead of failing the file.
 *
 * Pure: no I/O, no clock. Feed records in file order with `push`, then `finish`.
 */

export type StagedSender = 'U' | 'A';

/** One message kept in `lineChatImportThread.messages`. */
export type StagedMessage = Readonly<{
  /** U = customer, A = the OA account (admin, auto-reply or bot: the file cannot tell). */
  s: StagedSender;
  /** ISO time, already spread inside its minute/second so file order survives sorting. */
  t: string;
  x: string;
  /** Hash of the message content without the customer; see `contentHash`. */
  h: string;
}>;

export type CsvRowError = Readonly<{ line: number; reason: CsvRowErrorReason }>;

export type CsvRowErrorReason =
  | 'NO_HEADER'
  | 'BAD_DATE'
  | 'UNKNOWN_SENDER'
  | 'EMPTY_CONTENT'
  | 'THREAD_TRUNCATED';

export type MappedCsvFile = Readonly<{
  /** Customer name read from the rows; the file name when no customer row names one. */
  rawName: string;
  normalizedName: string;
  messages: StagedMessage[];
  errors: CsvRowError[];
  skippedByDate: number;
  headerFound: boolean;
}>;

export type CsvMapperOptions = Readonly<{
  fileName: string;
  utcOffsetMinutes: number;
  /** Inclusive local dates "YYYY-MM-DD". */
  fromDate?: string | null;
  toDate?: string | null;
  extraAliases?: Partial<Record<LineCsvColumn, string[]>>;
  /** Max header search depth; metadata lines above the header are skipped. */
  maxHeaderSearchLines?: number;
}>;

export const MAX_MESSAGE_TEXT = 5_000;
/** Most recent messages kept per customer; older ones are dropped (THREAD_TRUNCATED). */
export const MAX_THREAD_MESSAGES = 20_000;
const MINUTE_STEP_MS = 10;
const SECOND_STEP_MS = 1;

const BUILT_IN_ALIASES: Record<LineCsvColumn, string[]> = {
  senderType: [
    'sender type',
    'sendertype',
    'sender_type',
    'type',
    '送信者タイプ',
    'ประเภทผู้ส่ง',
    'ประเภท',
  ],
  senderName: [
    'sender name',
    'sendername',
    'sender_name',
    'sender',
    'name',
    '送信者名',
    'ชื่อผู้ส่ง',
    'ผู้ส่ง',
  ],
  date: ['date', 'sent date', 'send date', '送信日', 'วันที่', 'วันที่ส่ง'],
  time: ['time', 'sent time', 'send time', '送信時刻', 'เวลา', 'เวลาที่ส่ง'],
  datetime: [
    'datetime',
    'date time',
    'date/time',
    'timestamp',
    'sent at',
    '送信日時',
    'วันเวลา',
    'วันที่และเวลา',
  ],
  content: [
    'content',
    'contents',
    'message',
    'text',
    'body',
    '内容',
    'メッセージ',
    'ข้อความ',
    'เนื้อหา',
  ],
};

const USER_SENDER_VALUES = [
  'user',
  'customer',
  'friend',
  'ユーザー',
  '友だち',
  'ผู้ใช้',
  'ลูกค้า',
  'เพื่อน',
];
const ACCOUNT_SENDER_VALUES = [
  'account',
  'official account',
  'oa',
  'admin',
  'administrator',
  'bot',
  'staff',
  'manager',
  'operator',
  'system',
  'ai',
  'chatbot',
  'auto-reply',
  'auto reply',
  'autoreply',
  'auto-response',
  'auto response',
  'アカウント',
  'ボット',
  '自動応答',
  '管理者',
  'บัญชี',
  'บัญชีทางการ',
  'แอดมิน',
  'ผู้ดูแล',
  'ผู้ดูแลระบบ',
  'ระบบ',
  'บอท',
  'ตอบกลับอัตโนมัติ',
  'ข้อความตอบกลับอัตโนมัติ',
];

/** Placeholders the backup writes for non-text messages, mapped to a Thai label. */
const PLACEHOLDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\[?(sticker|stamp|スタンプ|สติ๊?[กข]เกอร์)\]?$/i, '[สติกเกอร์]'],
  [/^\[?(photo|image|picture|写真|画像|รูป|รูปภาพ)\]?$/i, '[รูปภาพ]'],
  [/^\[?(video|動画|วิดีโอ)\]?$/i, '[วิดีโอ]'],
  [/^\[?(file|ファイル|ไฟล์)\]?$/i, '[ไฟล์]'],
  [
    /^\[?(audio|voice message|ボイスメッセージ|ข้อความเสียง)\]?$/i,
    '[ข้อความเสียง]',
  ],
  [/^\[?(location|位置情報|ตำแหน่ง)\]?$/i, '[ตำแหน่ง]'],
];

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** The form two customer names are compared in. Exact match only; never fuzzy. */
export function normalizeCustomerName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 255);
}

function headerKey(cell: string): string {
  return cell
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function fileNameToCustomerName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.csv$/i, '').trim();
}

/** Same content hash for the same message whichever export it came from. */
export function contentHash(
  sender: StagedSender,
  bucketIso: string,
  text: string,
  ordinal: number,
): string {
  return createHash('sha256')
    .update(`${sender}\u0000${bucketIso}\u0000${text}\u0000${ordinal}`)
    .digest('hex')
    .slice(0, 32);
}

type ColumnIndex = Partial<Record<LineCsvColumn, number>>;

type ParsedTime = Readonly<{
  bucketMs: number;
  precision: 'minute' | 'second';
}>;

export class LineChatCsvMapper {
  private readonly aliases: Record<LineCsvColumn, Set<string>>;
  private readonly fromMs: number | null;
  private readonly toMs: number | null;
  private readonly maxHeaderSearch: number;

  private columns: ColumnIndex | null = null;
  private line = 0;
  private customerName: string | null = null;
  private skippedByDate = 0;
  private truncated = false;
  private readonly messages: StagedMessage[] = [];
  private readonly errors: CsvRowError[] = [];
  /** Next slot inside a minute/second bucket, so equal times keep file order. */
  private readonly bucketSeq = new Map<number, number>();
  /** Occurrences of the same (sender, bucket, text), so a repeated "ok" stays distinct. */
  private readonly tripleSeq = new Map<string, number>();

  constructor(private readonly options: CsvMapperOptions) {
    this.aliases = {} as Record<LineCsvColumn, Set<string>>;
    for (const column of Object.keys(BUILT_IN_ALIASES) as LineCsvColumn[]) {
      this.aliases[column] = new Set(
        [
          ...BUILT_IN_ALIASES[column],
          ...(options.extraAliases?.[column] ?? []),
        ].map(headerKey),
      );
    }
    this.fromMs = options.fromDate
      ? this.localDayStart(options.fromDate)
      : null;
    const toStart = options.toDate ? this.localDayStart(options.toDate) : null;
    this.toMs = toStart === null ? null : toStart + 24 * 60 * 60 * 1000;
    this.maxHeaderSearch = options.maxHeaderSearchLines ?? 30;
  }

  push(record: readonly string[]): void {
    this.line += 1;
    if (record.every((cell) => !cell?.trim())) return;

    if (!this.columns) {
      this.columns = this.detectHeader(record);
      if (!this.columns && this.line >= this.maxHeaderSearch) {
        // Stop looking: every later row is reported once, as NO_HEADER below.
        this.columns = {};
      }
      return;
    }

    if (this.columns.content === undefined) {
      if (this.errors.length === 0)
        this.errors.push({ line: this.line, reason: 'NO_HEADER' });
      return;
    }

    this.mapRow(record);
  }

  finish(): MappedCsvFile {
    this.truncate();
    if (this.truncated) {
      this.errors.push({ line: this.line, reason: 'THREAD_TRUNCATED' });
    }
    const headerFound = this.columns?.content !== undefined;
    if (!headerFound && this.errors.length === 0) {
      this.errors.push({ line: this.line, reason: 'NO_HEADER' });
    }
    const rawName =
      (
        this.customerName ?? fileNameToCustomerName(this.options.fileName)
      ).slice(0, 255) || 'Unknown';

    return {
      rawName,
      normalizedName: normalizeCustomerName(rawName),
      messages: this.messages,
      errors: this.errors,
      skippedByDate: this.skippedByDate,
      headerFound,
    };
  }

  private detectHeader(record: readonly string[]): ColumnIndex | null {
    const found: ColumnIndex = {};
    record.forEach((cell, index) => {
      const key = headerKey(cell ?? '');
      for (const column of Object.keys(this.aliases) as LineCsvColumn[]) {
        if (found[column] === undefined && this.aliases[column].has(key)) {
          found[column] = index;
          return;
        }
      }
    });

    const hasTime = found.datetime !== undefined || found.date !== undefined;
    const hasSender =
      found.senderType !== undefined || found.senderName !== undefined;
    return found.content !== undefined && hasTime && hasSender ? found : null;
  }

  private mapRow(record: readonly string[]): void {
    const columns = this.columns!;
    const cell = (column: LineCsvColumn) =>
      columns[column] === undefined
        ? ''
        : (record[columns[column]] ?? '').trim();

    const time = this.parseTime(
      cell('datetime') || `${cell('date')} ${cell('time')}`,
    );
    if (!time) {
      this.errors.push({ line: this.line, reason: 'BAD_DATE' });
      return;
    }

    const sender = this.senderOf(cell('senderType'), cell('senderName'));
    if (!sender) {
      this.errors.push({ line: this.line, reason: 'UNKNOWN_SENDER' });
      return;
    }

    const content = (record[columns.content!] ?? '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!content) {
      this.errors.push({ line: this.line, reason: 'EMPTY_CONTENT' });
      return;
    }

    if (sender === 'U' && !this.customerName && cell('senderName')) {
      this.customerName = cell('senderName');
    }

    if (
      (this.fromMs !== null && time.bucketMs < this.fromMs) ||
      (this.toMs !== null && time.bucketMs >= this.toMs)
    ) {
      this.skippedByDate += 1;
      return;
    }

    const text = placeholderOf(content) ?? content.slice(0, MAX_MESSAGE_TEXT);
    const step = time.precision === 'minute' ? MINUTE_STEP_MS : SECOND_STEP_MS;
    const slots = time.precision === 'minute' ? 60_000 / step : 1_000 / step;
    const seq = this.bucketSeq.get(time.bucketMs) ?? 0;
    this.bucketSeq.set(time.bucketMs, seq + 1);
    const at = time.bucketMs + Math.min(seq, slots - 1) * step;

    const bucketIso = new Date(time.bucketMs).toISOString();
    const tripleKey = `${sender}\u0000${bucketIso}\u0000${text}`;
    const ordinal = this.tripleSeq.get(tripleKey) ?? 0;
    this.tripleSeq.set(tripleKey, ordinal + 1);

    this.messages.push({
      s: sender,
      t: new Date(at).toISOString(),
      x: text,
      h: contentHash(sender, bucketIso, text, ordinal),
    });
    // Trim in large steps so memory stays bounded without shifting every row.
    if (this.messages.length >= MAX_THREAD_MESSAGES * 2) this.truncate();
  }

  private truncate(): void {
    if (this.messages.length <= MAX_THREAD_MESSAGES) return;
    this.messages.splice(0, this.messages.length - MAX_THREAD_MESSAGES);
    this.truncated = true;
  }

  private senderOf(type: string, name: string): StagedSender | null {
    const key = headerKey(type);
    if (key) {
      if (USER_SENDER_VALUES.includes(key)) return 'U';
      if (ACCOUNT_SENDER_VALUES.includes(key)) return 'A';
      return null;
    }
    // No type column: a row named after the file's customer is the customer.
    if (!name) return null;
    const fileCustomer = normalizeCustomerName(
      fileNameToCustomerName(this.options.fileName),
    );
    return normalizeCustomerName(name) === fileCustomer ? 'U' : 'A';
  }

  /**
   * Accepts "YYYY/MM/DD HH:mm[:ss[.fff]]", "YYYY-MM-DD", "DD/MM/YYYY",
   * Buddhist-era years (> 2400), "T" between date and time, a weekday in
   * parentheses, AM/PM, and an explicit offset ("Z", "+07:00"), which wins
   * over `utcOffsetMinutes`. Returns the UTC start of the minute (or second)
   * the row was sent in.
   */
  private parseTime(raw: string): ParsedTime | null {
    const value = raw
      .normalize('NFKC')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/(\d)T(\d)/, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();

    const match = DATE_TIME.exec(value);
    if (!match) return null;
    const [year, month, day] = match[1]
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : [Number(match[6]), Number(match[5]), Number(match[4])];
    let hour = Number(match[7]);
    const minute = Number(match[8]);
    const second = match[9] === undefined ? null : Number(match[9]);
    const meridiem = match[10]?.toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
    }
    const offsetMinutes = offsetOf(match[11]) ?? this.options.utcOffsetMinutes;

    const gregorian = year > 2400 ? year - 543 : year;
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      (second ?? 0) > 59
    ) {
      return null;
    }

    const localMs = Date.UTC(
      gregorian,
      month - 1,
      day,
      hour,
      minute,
      second ?? 0,
    );
    const check = new Date(localMs);
    if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1)
      return null;

    return {
      bucketMs: localMs - offsetMinutes * 60_000,
      precision: second === null ? 'minute' : 'second',
    };
  }

  private localDayStart(date: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return null;
    return (
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) -
      this.options.utcOffsetMinutes * 60_000
    );
  }
}

/** date (Y-M-D or D-M-Y), time, optional fraction, AM/PM and offset. */
const DATE_TIME =
  /^(?:(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})|(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})) (\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,6})?)? ?(am|pm)? ?(z|[+-]\d{2}:?\d{2})?$/i;

/** "Z" → 0, "+07:00" / "+0700" → 420; undefined when absent. */
function offsetOf(suffix: string | undefined): number | undefined {
  if (!suffix) return undefined;
  if (suffix.toLowerCase() === 'z') return 0;
  const sign = suffix.startsWith('-') ? -1 : 1;
  const digits = suffix.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

function placeholderOf(content: string): string | null {
  for (const [pattern, label] of PLACEHOLDERS) {
    if (pattern.test(content)) return label;
  }
  return null;
}

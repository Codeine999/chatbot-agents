import { ConsoleLogger, LogLevel } from '@nestjs/common';

/** Bright black: loud enough to read, quiet enough to skip. */
const DIM = '\x1B[90m';
const DEFAULT_COLOR = '\x1B[39m';
const BOLD = '\x1B[1m';
const NORMAL_WEIGHT = '\x1B[22m';
const SELECTED = '\x1B[32m';

/** A diagnostic block is `[Tag]` followed by indented `key=value` rows. */
const BLOCK_HEADER = /^\[[^\]\n]+\]$/;
/** A retrieval candidate row: `*#1 SOURCE:id`, where `*` means "sent to the model". */
const CANDIDATE_ROW = /^(\s*)([* ])(#\d+\s.*)$/u;

/**
 * Colours the flow logs by structure instead of painting the whole block one
 * colour: the tag keeps its level colour so severity stays scannable, field
 * names recede, and values stay at full contrast.
 */
export class AppLogger extends ConsoleLogger {
  /**
   * Nest puts pid, timestamp, level, context and the message on one line, which
   * pushes a block's own tag far to the right. Break after the timestamp so the
   * level, the context and the tag start the second line at column 0.
   */
  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    // ConsoleLogger#stringifyMessage is typed `any`; it returns the rendered
    // string for every input this logger receives.
    const output = String(this.stringifyMessage(message, logLevel));
    const stamp = this.colorize(
      `${pidMessage}${this.getTimestamp()}`,
      logLevel,
    );
    // The label is padded to align under Nest's one-line layout; at the start
    // of its own line that padding is only noise.
    const level = this.colorize(formattedLogLevel.trim(), logLevel);
    return `${stamp}${timestampDiff}\n${level} ${contextMessage}${output}\n`;
  }

  protected colorize(message: string, logLevel: LogLevel): string {
    if (!this.options.colors || this.options.json) return message;

    const [header, ...rows] = message.split('\n');
    if (!rows.length || !BLOCK_HEADER.test(header)) {
      return super.colorize(message, logLevel);
    }

    const color = this.getColorByLogLevel(logLevel);
    return [
      `${BOLD}${color(header)}${NORMAL_WEIGHT}`,
      ...rows.map((row) => this.colorizeRow(row)),
    ].join('\n');
  }

  private colorizeRow(row: string): string {
    const candidate = CANDIDATE_ROW.exec(row);
    if (candidate) {
      const [, indent, mark, rest] = candidate;
      return mark === '*'
        ? `${indent}${SELECTED}${BOLD}*${rest}${NORMAL_WEIGHT}${DEFAULT_COLOR}`
        : `${indent}${DIM}${mark}${rest}${DEFAULT_COLOR}`;
    }

    const separator = row.indexOf('=');
    // A row with no field name (`candidates:`, the "+N more" tail) is a label.
    if (separator < 0) return `${DIM}${row}${DEFAULT_COLOR}`;

    return (
      `${DIM}${row.slice(0, separator + 1)}${DEFAULT_COLOR}` +
      row.slice(separator + 1)
    );
  }
}

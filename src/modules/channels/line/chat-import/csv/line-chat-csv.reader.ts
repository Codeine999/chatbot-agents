import { parse } from 'csv-parse';
import { StringDecoder } from 'node:string_decoder';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import {
  LineChatCsvMapper,
  type CsvMapperOptions,
  type MappedCsvFile,
} from './line-chat-csv.mapper';

/** Records between two event-loop yields, so a huge file never blocks the worker. */
const YIELD_EVERY = 2_000;

/**
 * UTF-8 (with or without BOM) is passed through; a UTF-16 LE file, which
 * Excel-style exports sometimes produce, is decoded to UTF-8 first.
 */
function utf8Decoder(): Transform {
  let decided = false;
  let utf16: StringDecoder | null = null;

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!decided) {
        decided = true;
        if (chunk[0] === 0xff && chunk[1] === 0xfe) {
          utf16 = new StringDecoder('utf16le');
          chunk = chunk.subarray(2);
        }
      }
      done(null, utf16 ? Buffer.from(utf16.write(chunk), 'utf8') : chunk);
    },
    flush(done) {
      done(null, utf16 ? Buffer.from(utf16.end(), 'utf8') : undefined);
    },
  });
}

/** Reads one CSV entry of the backup into the staged messages of one thread. */
export async function readLineChatCsv(
  source: Readable,
  options: CsvMapperOptions,
): Promise<MappedCsvFile> {
  const mapper = new LineChatCsvMapper(options);
  const parser = parse({
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: false,
  });

  // pipeline() destroys every stage when one fails (a corrupt zip entry, a
  // size lie caught by yauzl), so the loop below throws instead of hanging.
  const piped = pipeline(source, utf8Decoder(), parser);
  const consumed = (async () => {
    let seen = 0;
    for await (const record of parser as AsyncIterable<string[]>) {
      mapper.push(record);
      seen += 1;
      if (seen % YIELD_EVERY === 0) await yieldToLoop();
    }
  })();

  await Promise.all([piped, consumed]);
  return mapper.finish();
}

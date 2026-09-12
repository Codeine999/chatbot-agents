/**
 * Minimal PNG/JPEG header reader.
 *
 * LINE rejects a rich menu image whose pixel size does not match the menu's
 * declared `size`, and it does so only at upload time — after the menu has
 * already been created. Reading the dimensions locally lets the back office
 * fail the upload immediately instead.
 */
export type ImageDimensions = {
  width: number;
  height: number;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Start-of-frame markers carry the dimensions; these two do not. */
const JPEG_NON_SOF_MARKERS = new Set([0xc4, 0xc8, 0xcc]);

export const readImageDimensions = (
  buffer: Buffer,
): ImageDimensions | null => {
  return readPngDimensions(buffer) ?? readJpegDimensions(buffer);
};

const readPngDimensions = (buffer: Buffer): ImageDimensions | null => {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // Bytes 12-16 name the chunk; only IHDR holds the dimensions.
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
};

const readJpegDimensions = (buffer: Buffer): ImageDimensions | null => {
  if (buffer.length < 4) return null;
  if (buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;

  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];

    // Padding fill bytes and standalone markers carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;

    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_SOF_MARKERS.has(marker);

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  return null;
};

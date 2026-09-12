import { readImageDimensions } from './image-size';

const pngOf = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const jpegOf = (width: number, height: number): Buffer => {
  // SOI, a JFIF APP0 segment to skip over, then the SOF0 that holds the size.
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    (() => {
      const segment = Buffer.alloc(16);
      segment.writeUInt16BE(16, 0);
      segment.write('JFIF\0', 2, 'ascii');
      return segment;
    })(),
  ]);

  const sof0 = Buffer.alloc(11);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(9, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
};

describe('readImageDimensions', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(readImageDimensions(pngOf(2500, 1686))).toEqual({
      width: 2500,
      height: 1686,
    });
  });

  it('reads JPEG dimensions from the first start-of-frame marker', () => {
    expect(readImageDimensions(jpegOf(1200, 810))).toEqual({
      width: 1200,
      height: 810,
    });
  });

  it('returns null for a format LINE does not accept', () => {
    expect(readImageDimensions(Buffer.from('GIF89a and then some'))).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

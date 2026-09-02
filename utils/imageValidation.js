'use strict';

/**
 * What an uploaded picture actually is, read from the bytes.
 *
 * routes/reports.js already established the rule this file takes further: the
 * declared type and the filename are both things the *uploader* chose, so
 * neither is evidence. That check compares the two against a list, which
 * catches a mistake and a lazy attacker. It does not catch a file called
 * `me.png`, announced as `image/png`, whose contents are a shell script -- and
 * for an avatar, which is served straight back to a browser, that is the case
 * worth caring about.
 *
 * So nothing here reads `file.mimetype` or `file.originalname` at all. The
 * format is decided by the magic bytes, the dimensions are parsed out of the
 * header, and the type the file is later *served* as is the one derived here --
 * never the one the uploader claimed. A file that is not one of three formats
 * is refused, whatever it says on the tin.
 *
 * Three formats, deliberately:
 *
 *   png   jpeg   webp
 *
 * SVG is absent and always will be: an SVG is a document that can carry script,
 * not a picture. GIF is absent because an animated avatar is a decision nobody
 * asked for and a decompression bomb nobody wants.
 *
 * Pure JavaScript, no native dependency. `sharp` would parse these for us and
 * would also put a platform-specific binary in a bundle that has to build for
 * a serverless target -- a large cost for a header read that is forty lines.
 */

const FORMATS = {
  png: { mimeType: 'image/png', extension: '.png' },
  jpeg: { mimeType: 'image/jpeg', extension: '.jpg' },
  webp: { mimeType: 'image/webp', extension: '.webp' },
};

/** Limits, generous enough for a real photo and small enough to store inline. */
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_DIMENSION = 32;
const MAX_DIMENSION = 4096;

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG puts IHDR first by specification, so the size is always at a fixed offset. */
function readPng(buf) {
  if (!startsWith(buf, PNG_MAGIC)) return null;
  // Bytes 12-15 must spell IHDR, or this is a PNG signature glued to something else.
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Start-of-frame markers: every one of them carries the picture's size. */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * JPEG has no fixed header, so the segments have to be walked.
 *
 * Bounded on every axis: the loop can only move forward, a segment shorter than
 * its own header ends it, and running off the end returns null rather than
 * throwing. A malformed file is a refusal, not a crash.
 */
function readJpeg(buf) {
  if (!startsWith(buf, [0xff, 0xd8, 0xff])) return null;

  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) return null; // lost the segment chain: malformed
    const marker = buf[offset + 1];

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: the compressed data begins and there is no size after it.
    if (marker === 0xda || marker === 0xd9) return null;

    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;

    if (JPEG_SOF.has(marker)) {
      if (offset + 9 > buf.length) return null;
      return { format: 'jpeg', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * WebP comes in three flavours, each storing its size somewhere different.
 *
 * Lossy (VP8), lossless (VP8L) and extended (VP8X). Reading only one of them
 * would refuse perfectly good files from whichever encoder the browser chose.
 */
function readWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = buf.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    // Key-frame header: a three-byte start code, then 14-bit width and height.
    if (!startsWith(buf, [0x9d, 0x01, 0x2a], 23)) return null;
    return {
      format: 'webp',
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    // 14 bits of width-1 then 14 bits of height-1, packed little-endian.
    const bits = buf.readUInt32LE(21);
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    // Canvas size as two 24-bit little-endian values, each stored minus one.
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { format: 'webp', width, height };
  }

  return null;
}

/**
 * The format and size of these bytes, or null if they are not a picture we
 * accept. Never throws: every reader above is bounds-checked, and a buffer of
 * random noise simply fails to match.
 */
function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const read = readPng(buffer) || readJpeg(buffer) || readWebp(buffer);
  if (!read) return null;
  if (!Number.isInteger(read.width) || !Number.isInteger(read.height)) return null;
  if (read.width <= 0 || read.height <= 0) return null;
  return { ...read, ...FORMATS[read.format] };
}

/**
 * Whether these bytes may become somebody's avatar, and why not when they may
 * not.
 *
 * Returns `{ ok: true, image }` or `{ ok: false, error, status }`. The messages
 * are written for the person who picked the file, so they say what to do about
 * it rather than naming the check that failed.
 */
function validateAvatar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, error: 'No image was uploaded.' };
  }
  if (buffer.length > MAX_BYTES) {
    const mb = (MAX_BYTES / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      status: 413,
      error: `That picture is larger than ${mb}MB. Crop it or save it smaller and try again.`,
    };
  }

  const image = sniff(buffer);
  if (!image) {
    return {
      ok: false,
      status: 415,
      error: 'That file is not a PNG, JPEG or WebP image. Whatever it is named, its contents are not a picture we can use.',
    };
  }

  if (image.width < MIN_DIMENSION || image.height < MIN_DIMENSION) {
    return {
      ok: false,
      status: 422,
      error: `That image is ${image.width}x${image.height}. It needs to be at least ${MIN_DIMENSION}x${MIN_DIMENSION}.`,
    };
  }
  if (image.width > MAX_DIMENSION || image.height > MAX_DIMENSION) {
    return {
      ok: false,
      status: 422,
      error: `That image is ${image.width}x${image.height}, which is larger than ${MAX_DIMENSION} pixels on a side.`,
    };
  }

  // A picture 20 times wider than it is tall is not a portrait, and cropping it
  // to a circle would show a sliver of it. Better to say so than to store it
  // and let the avatar look broken everywhere.
  const ratio = image.width / image.height;
  if (ratio > 10 || ratio < 0.1) {
    return {
      ok: false,
      status: 422,
      error: 'That image is far wider than it is tall (or the other way round). Crop it closer to a square first.',
    };
  }

  return { ok: true, image };
}

module.exports = {
  FORMATS,
  MAX_BYTES,
  MIN_DIMENSION,
  MAX_DIMENSION,
  sniff,
  validateAvatar,
};

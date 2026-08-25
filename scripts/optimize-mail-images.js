'use strict';

/**
 * Losslessly re-compress the images that travel inside email.
 *
 * Every one of these files is attached to the message itself, base64-encoded,
 * which costs another third on top of the file size -- so a byte saved here is
 * about 1.33 bytes off the wire, on every message, before the reader's client
 * has drawn anything. That is the whole reason this exists: mail images cannot
 * be cached between messages the way a web page's can, so they are paid for
 * again on every send.
 *
 * Nothing is resized and no colour is altered. The saving is entirely in how
 * the pixels are stored:
 *
 *   1. Palette form. The glyphs were exported as 8-bit RGBA -- four bytes a
 *      pixel -- but several use under 256 distinct colours, which fits an
 *      indexed PLTE at one byte a pixel before compression even starts.
 *   2. Per-row filter choice. PNG picks one of five filters per scanline and
 *      the exporter left most rows on none; the usual sum-of-absolute-
 *      differences heuristic picks a better one per row.
 *   3. A harder deflate. Level 9 across three strategies, keeping the smallest.
 *
 * Every file is decoded again after writing and compared pixel for pixel with
 * the original. A file that does not round-trip identically, or that does not
 * actually get smaller, is left exactly as it was.
 *
 * Run from the repo root after regenerating any mail art:
 *   npm run mail:optimize
 *
 * `frontend/public/` is the tracked source. `public/` is build output and is
 * only touched when it already exists, so a checkout that has never been built
 * is left alone.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ROOT = path.join(__dirname, '..');

/** The files email actually attaches: the wordmark and the glyph set. */
const TARGETS = ['ethixweb.png', 'mail-icons'];

// --- PNG ------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode to flat 8-bit RGBA.
 *
 * Only what this project's own art actually is: 8 bits a channel, no
 * interlacing. Anything else throws and the caller skips the file rather than
 * guessing at it.
 */
function decode(buf) {
  if (Buffer.compare(buf.subarray(0, 8), SIG) !== 0) throw new Error('not a PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const ctype = buf[25];
  const interlace = buf[28];
  if (depth !== 8) throw new Error(`bit depth ${depth} is not supported`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');

  let plte = null;
  let trns = null;
  const idat = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`colour type ${ctype} is not supported`);

  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const flat = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const o = y * stride;
    const u = o - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? flat[o + i - channels] : 0;
      const b = y > 0 ? flat[u + i] : 0;
      const c = i >= channels && y > 0 ? flat[u + i - channels] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      flat[o + i] = v & 255;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (ctype === 6) {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = flat[s + 3];
    } else if (ctype === 2) {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = 255;
    } else if (ctype === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = 255;
    } else if (ctype === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = flat[s + 1];
    } else {
      const idx = flat[s];
      rgba[d] = plte[idx * 3]; rgba[d + 1] = plte[idx * 3 + 1]; rgba[d + 2] = plte[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

/** Filter every scanline five ways, keep the cheapest by the usual heuristic. */
function filterRows(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * (stride + 1));
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  let op = 0;

  for (let y = 0; y < height; y++) {
    const o = y * stride;
    const u = o - stride;
    const score = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const x = pixels[o + i];
      const a = i >= bpp ? pixels[o + i - bpp] : 0;
      const b = y > 0 ? pixels[u + i] : 0;
      const c = i >= bpp && y > 0 ? pixels[u + i - bpp] : 0;
      const v0 = x;
      const v1 = (x - a) & 255;
      const v2 = (x - b) & 255;
      const v3 = (x - ((a + b) >> 1)) & 255;
      const v4 = (x - paeth(a, b, c)) & 255;
      cand[0][i] = v0; cand[1][i] = v1; cand[2][i] = v2; cand[3][i] = v3; cand[4][i] = v4;
      score[0] += v0 < 128 ? v0 : 256 - v0;
      score[1] += v1 < 128 ? v1 : 256 - v1;
      score[2] += v2 < 128 ? v2 : 256 - v2;
      score[3] += v3 < 128 ? v3 : 256 - v3;
      score[4] += v4 < 128 ? v4 : 256 - v4;
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (score[f] < score[best]) best = f;
    out[op++] = best;
    cand[best].copy(out, op);
    op += stride;
  }
  return out;
}

function deflateSmallest(raw) {
  const strategies = [
    zlib.constants.Z_DEFAULT_STRATEGY,
    zlib.constants.Z_FILTERED,
    zlib.constants.Z_RLE,
  ];
  let best = null;
  for (const strategy of strategies) {
    const z = zlib.deflateSync(raw, { level: 9, memLevel: 9, windowBits: 15, strategy });
    if (!best || z.length < best.length) best = z;
  }
  return best;
}

/** Re-encode: indexed when the art fits 256 colours, straight RGBA otherwise. */
function encode({ width, height, rgba }) {
  const index = new Map();
  const firstSeen = [];
  for (let i = 0, n = width * height; i < n; i++) {
    const d = i * 4;
    const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
    if (!index.has(key)) {
      index.set(key, firstSeen.length);
      firstSeen.push(d);
      if (index.size > 256) break;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;

  const parts = [];

  if (index.size <= 256) {
    // Transparent entries first so tRNS can stop at the last one that needs it
    // -- a chunk of 3 bytes instead of one entry per colour in the palette.
    const entries = firstSeen.map((d, i) => ({
      i, r: rgba[d], g: rgba[d + 1], b: rgba[d + 2], a: rgba[d + 3],
    }));
    entries.sort((x, y) => x.a - y.a || x.i - y.i);

    const remap = new Uint8Array(entries.length);
    entries.forEach((e, slot) => { remap[e.i] = slot; });

    const plte = Buffer.alloc(entries.length * 3);
    entries.forEach((e, i) => {
      plte[i * 3] = e.r; plte[i * 3 + 1] = e.g; plte[i * 3 + 2] = e.b;
    });

    let opaqueFrom = 0;
    entries.forEach((e, i) => { if (e.a !== 255) opaqueFrom = i + 1; });
    const trns = Buffer.alloc(opaqueFrom);
    for (let i = 0; i < opaqueFrom; i++) trns[i] = entries[i].a;

    const idx = Buffer.alloc(width * height);
    for (let i = 0, n = width * height; i < n; i++) {
      const d = i * 4;
      const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      idx[i] = remap[index.get(key)];
    }

    ihdr[9] = 3;
    parts.push(chunk('IHDR', ihdr), chunk('PLTE', plte));
    if (opaqueFrom) parts.push(chunk('tRNS', trns));
    parts.push(chunk('IDAT', deflateSmallest(filterRows(idx, width, height, 1))));
  } else {
    ihdr[9] = 6;
    parts.push(chunk('IHDR', ihdr), chunk('IDAT', deflateSmallest(filterRows(rgba, width, height, 4))));
  }

  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([SIG, ...parts]);
}

// --- run ------------------------------------------------------------------

function pngsUnder(target) {
  if (!fs.existsSync(target)) return [];
  if (fs.statSync(target).isDirectory()) {
    return fs.readdirSync(target)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => path.join(target, f))
      .sort();
  }
  return target.toLowerCase().endsWith('.png') ? [target] : [];
}

function optimize(file) {
  const before = fs.readFileSync(file);
  const original = decode(before);
  const after = encode(original);

  if (after.length >= before.length) return { file, before: before.length, after: before.length, skipped: 'already smaller' };

  // The whole point is that nothing changed but the storage. Prove it before
  // overwriting anything.
  const check = decode(after);
  if (check.width !== original.width || check.height !== original.height
    || Buffer.compare(check.rgba, original.rgba) !== 0) {
    return { file, before: before.length, after: before.length, skipped: 'would not round-trip' };
  }

  fs.writeFileSync(file, after);
  return { file, before: before.length, after: after.length };
}

function main() {
  const roots = [path.join(ROOT, 'frontend', 'public'), path.join(ROOT, 'public')]
    .filter((dir) => fs.existsSync(dir));

  if (roots.length === 0) {
    console.error('Neither frontend/public/ nor public/ exists -- nothing to do.');
    process.exitCode = 1;
    return;
  }

  let before = 0;
  let after = 0;
  let changed = 0;

  for (const root of roots) {
    const files = TARGETS.flatMap((t) => pngsUnder(path.join(root, t)));
    if (files.length === 0) continue;
    console.log(`\n${path.relative(ROOT, root) || '.'}`);
    for (const file of files) {
      let result;
      try {
        result = optimize(file);
      } catch (err) {
        console.log(`  skip  ${path.basename(file).padEnd(22)} ${err.message}`);
        continue;
      }
      before += result.before;
      after += result.after;
      const name = path.basename(file).padEnd(22);
      if (result.skipped) {
        console.log(`  keep  ${name} ${result.skipped}`);
        continue;
      }
      changed += 1;
      const pct = ((1 - result.after / result.before) * 100).toFixed(0);
      console.log(
        `  ok    ${name} ${(result.before / 1024).toFixed(1).padStart(6)}K ->`
        + ` ${(result.after / 1024).toFixed(1).padStart(6)}K  -${pct}%`,
      );
    }
  }

  if (before === 0) {
    console.log('\nNo mail images found.');
    return;
  }
  console.log(
    `\n${changed} file(s) rewritten. ${(before / 1024).toFixed(1)}K -> ${(after / 1024).toFixed(1)}K`
    + ` (-${((1 - after / before) * 100).toFixed(0)}%, about`
    + ` ${(((before - after) * 4) / 3 / 1024).toFixed(0)}K less base64 on the wire).`,
  );
}

main();

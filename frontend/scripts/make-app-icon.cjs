'use strict';

/**
 * Builds public/app-icon.svg: the emblem, centred on an opaque brand plate,
 * with a maskable safe zone around it.
 *
 * Why this exists. The manifest used to hand Android `emblem-mark.png` twice --
 * once as `any` and once as `maskable` -- and that file is a transparent,
 * non-square mark with no margin. A maskable icon is cropped to whatever shape
 * the launcher wants (circle, squircle, teardrop) and only the middle 80% is
 * guaranteed to survive, so the mark lost its edges and the transparency was
 * filled with the manifest's background_color: a white disc with a clipped grey
 * emblem on it, which is not the brand.
 *
 * The plate here is the same near-black the app frames the mark on everywhere
 * else (the sidebar Brand block, the phone TopBar, the install card), and the
 * emblem sits at 50% of the canvas -- comfortably inside the 80% safe zone.
 *
 * SVG rather than PNG because this repo has no image toolchain: composing a
 * raster would mean adding sharp or ImageMagick to the build. An SVG with the
 * source PNG embedded as a data URI needs nothing but fs, and Chrome has taken
 * SVG manifest icons since 106. `emblem-mark.png` stays declared in the
 * manifest as a plain `any` icon so the PNG installability path is untouched
 * for anything that does not read SVG.
 *
 * Run: node scripts/make-app-icon.cjs
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SOURCE = path.join(PUBLIC_DIR, 'emblem-mark.png');
const OUTPUT = path.join(PUBLIC_DIR, 'app-icon.svg');

/** The plate colour, matching `bg-zinc-950` as used around the mark in-app. */
const PLATE = '#0b0b0d';

/** Canvas is 512; the mark occupies the middle 50%, well inside the 80% the
 *  maskable spec guarantees. */
const SIZE = 512;
const MARK = 256;

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source mark not found at ${SOURCE}`);
    process.exit(1);
  }

  const png = fs.readFileSync(SOURCE);
  const { width, height } = readPngSize(png);
  const scale = Math.min(MARK / width, MARK / height);
  const w = width * scale;
  const h = height * scale;
  const x = (SIZE - w) / 2;
  const y = (SIZE - h) / 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${PLATE}"/>
  <image href="data:image/png;base64,${png.toString('base64')}" x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}"/>
</svg>
`;

  fs.writeFileSync(OUTPUT, svg);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)} (${svg.length} bytes) from a ${width}x${height} mark.`);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** IHDR is always the first chunk, so width and height are at a fixed offset. */
function readPngSize(buf) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    console.error('Source is not a PNG.');
    process.exit(1);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

main();

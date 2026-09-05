/**
 * Turning whatever somebody picked into an avatar-sized picture.
 *
 * This is the "optimized thumbnail" half of the feature, and it runs here
 * rather than on the server for a specific reason: resizing on the server means
 * a native image library in the bundle, and this app deploys to a serverless
 * target where a platform-specific binary is a build problem rather than a
 * dependency. The browser already has a full image decoder and an encoder, both
 * hardware-accelerated, so a 4MB photo from a phone becomes a 20KB square
 * before it ever touches the network.
 *
 * The server does not trust any of this. It re-reads the format from the magic
 * bytes and re-checks the dimensions and the size (utils/imageValidation.js),
 * because a file can be posted with curl and this file cannot be a boundary.
 * What it is, is a courtesy: to the person on a phone connection, and to the
 * database that would otherwise store the original.
 */

/** What the avatar is scaled to. Twice the largest place one is drawn, for retina. */
export const AVATAR_SIZE = 256;

/** Matches the server's list. Anything else is refused before it is read. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(",");

/** The server's own ceiling, restated so the picker can refuse early. */
export const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

/** How far in the editor lets someone push a picture before it turns to mush. */
export const MAX_ZOOM = 4;

export class AvatarError extends Error {}

/**
 * How the source sits inside the square, as the editor is holding it.
 *
 * `scale` is relative to "just covers the square", so 1 is the tightest fit
 * that leaves no gap and there is no way to express a transform with a hole in
 * it. `ox`/`oy` are fractions of the square rather than pixels, which is what
 * lets the on-screen preview and the 256px export run the identical numbers --
 * the preview is simply the same drawing at a different size, so what someone
 * approves is exactly what is uploaded.
 */
export interface AvatarTransform {
  scale: number;
  ox: number;
  oy: number;
  /** Quarter turns only: 0, 90, 180 or 270. */
  rotation: number;
}

export const IDENTITY_TRANSFORM: AvatarTransform = { scale: 1, ox: 0, oy: 0, rotation: 0 };

/** The source's dimensions as they appear once the quarter-turn is applied. */
function dims(img: HTMLImageElement, rotation: number) {
  return rotation % 180 === 0
    ? { w: img.naturalWidth, h: img.naturalHeight }
    : { w: img.naturalHeight, h: img.naturalWidth };
}

/**
 * How far the picture may slide before a corner of the square would be empty.
 *
 * In the same fractional units as the transform, so this needs no viewport and
 * cannot disagree with the drawing below.
 */
export function maxOffset(img: HTMLImageElement, t: AvatarTransform) {
  const { w, h } = dims(img, t.rotation);
  const min = Math.min(w, h);
  return {
    x: Math.max(0, ((w * t.scale) / min - 1) / 2),
    y: Math.max(0, ((h * t.scale) / min - 1) / 2),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The nearest transform that still fills the square completely. */
export function clampTransform(img: HTMLImageElement, t: AvatarTransform): AvatarTransform {
  const scale = clamp(t.scale, 1, MAX_ZOOM);
  const bounded = { ...t, scale };
  const m = maxOffset(img, bounded);
  return { ...bounded, ox: clamp(bounded.ox, -m.x, m.x), oy: clamp(bounded.oy, -m.y, m.y) };
}

/**
 * Paint the framed picture into a square canvas of any size.
 *
 * One function for the live preview and for the export. The preview is a small
 * canvas and the export a 256px one; nothing else differs, so there is no
 * second implementation to drift out of agreement with the first.
 */
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  t: AvatarTransform,
  size: number,
) {
  const { w, h } = dims(img, t.rotation);
  // Pixels of output per pixel of source, at scale 1.
  const cover = size / Math.min(w, h);
  const s = cover * t.scale;

  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(size / 2 + t.ox * size, size / 2 + t.oy * size);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(s, s);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.restore();
}

/**
 * A decoded image, and the handle that frees the memory behind it.
 *
 * The two travel together because the caller decides how long the picture is
 * needed for -- an instant, for the centre-crop path; as long as somebody is
 * framing it, for the editor.
 */
export interface LoadedImage {
  image: HTMLImageElement;
  release: () => void;
}

/**
 * Read a picked file into a decoded image, refusing anything that is not one.
 *
 * The type and size checks happen here rather than at the point of upload so
 * somebody learns their file is unusable before they have spent time framing
 * it.
 *
 * The object URL is deliberately NOT revoked when the image loads, which is the
 * obvious place to do it and is wrong: it leaves an <img> that has loaded but
 * whose source no longer exists, and a draw in any later task -- after a dialog
 * has finished animating, after a drag, after a re-render -- can come back
 * blank. It held together while the only caller drew immediately and broke the
 * moment one drew later. The caller releases it when it is genuinely finished.
 */
export function loadImageFile(file: File): Promise<LoadedImage> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return Promise.reject(new AvatarError("Pick a PNG, JPEG or WebP image."));
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return Promise.reject(new AvatarError("That image is very large. Pick one under 12MB."));
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    };

    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        release();
        reject(new AvatarError("That image has no size to it."));
        return;
      }
      resolve({ image: img, release });
    };
    img.onerror = () => {
      release();
      // A file the browser's own decoder will not open is not a picture,
      // whatever its name says.
      reject(new AvatarError("That file could not be opened as an image."));
    };
    img.src = url;
  });
}

/**
 * PNG in, PNG out; everything else becomes JPEG.
 *
 * Keeping PNG matters for a logo or a screenshot with flat colour, where JPEG
 * would put ringing around every edge; using JPEG for photographs is what makes
 * the file small.
 */
function outputType(sourceType: string) {
  return sourceType === "image/png" ? "image/png" : "image/jpeg";
}

/** Render the framed picture at AVATAR_SIZE and encode it for upload. */
export async function exportAvatar(
  img: HTMLImageElement,
  transform: AvatarTransform,
  sourceType: string,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new AvatarError("This browser cannot resize images.");

  drawAvatar(ctx, img, clampTransform(img, transform), AVATAR_SIZE);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputType(sourceType), 0.9),
  );
  if (!blob) throw new AvatarError("That image could not be prepared. Try a different one.");
  return blob;
}

/**
 * The no-editor path: centre the picture in the square and encode it.
 *
 * Centred rather than top-aligned because a portrait's subject is in the middle
 * far more often than not, and an avatar that cuts someone's forehead off is
 * the kind of thing people notice immediately and cannot fix.
 */
export async function prepareAvatar(file: File): Promise<Blob> {
  const { image, release } = await loadImageFile(file);
  try {
    return await exportAvatar(image, IDENTITY_TRANSFORM, file.type);
  } finally {
    release();
  }
}

/**
 * Where to fetch one account's picture.
 *
 * `updatedAt` rides along as a query parameter so a replaced picture is a
 * different URL. Without it the browser holds the old face for as long as its
 * cache says to, and somebody who has just changed their photo sees the
 * previous one staring back -- the single most common complaint about avatar
 * features, and it is entirely avoidable.
 */
export function avatarUrl(userId: string, updatedAt?: number | null): string {
  const base = import.meta.env.VITE_API_BASE_URL || "";
  const version = updatedAt ? `?v=${updatedAt}` : "";
  return `${base}/api/users/${encodeURIComponent(userId)}/avatar${version}`;
}

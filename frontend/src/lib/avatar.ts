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

export class AvatarError extends Error {}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // A file the browser's own decoder will not open is not a picture,
      // whatever its name says.
      reject(new AvatarError("That file could not be opened as an image."));
    };
    img.src = url;
  });
}

/**
 * Crop to a centred square, scale to AVATAR_SIZE, and encode.
 *
 * Centred rather than top-aligned because a portrait's subject is in the middle
 * far more often than not, and an avatar that cuts someone's forehead off is
 * the kind of thing people notice immediately and cannot fix.
 *
 * PNG in, PNG out; everything else becomes JPEG. Keeping PNG matters for a
 * logo or a screenshot with flat colour, where JPEG would put ringing around
 * every edge; using JPEG for photographs is what makes the file small.
 */
export async function prepareAvatar(file: File): Promise<Blob> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new AvatarError("Pick a PNG, JPEG or WebP image.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new AvatarError("That image is very large. Pick one under 12MB.");
  }

  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new AvatarError("That image has no size to it.");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new AvatarError("This browser cannot resize images.");

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );

  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, 0.9),
  );
  if (!blob) throw new AvatarError("That image could not be prepared. Try a different one.");
  return blob;
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

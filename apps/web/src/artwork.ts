import { makeArtwork, PAYLOAD_LIMITS, randomUUID, type VaultArtwork } from "@quancard/protocol";

/**
 * Card photos are re-encoded in the browser before encryption: decoding and
 * redrawing on a canvas drops EXIF (location, camera, original thumbnail),
 * the long edge is capped at 1600 px, and quality steps down until the JPEG
 * fits the 1 MiB soft budget. Sync v1 embeds the photo in every revision of
 * its item, so small files keep history growth in check. 4 MiB is the
 * protocol's hard limit.
 */

const MAX_EDGE = 1600;
const SOFT_BYTES = 1024 * 1024;
const INPUT_LIMIT = 20 * 1024 * 1024;

export class ArtworkError extends Error {}

export async function processPhoto(file: File): Promise<VaultArtwork> {
  if (file.size > INPUT_LIMIT || !file.type.startsWith("image/")) throw new ArtworkError("input");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ArtworkError("decode");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new ArtworkError("decode");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let bytes: Uint8Array | null = null;
  for (const quality of [0.82, 0.72, 0.62, 0.5]) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length <= SOFT_BYTES) break;
  }
  context.clearRect(0, 0, width, height);
  if (!bytes || bytes.length > PAYLOAD_LIMITS.artworkBytes) throw new ArtworkError("size");
  return makeArtwork(randomUUID().toLowerCase(), bytes);
}

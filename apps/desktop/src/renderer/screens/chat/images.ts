import type { ImageMediaType, ImageUpload, StoredImage } from "../../client/chat.js";

/**
 * Images pasted or dropped into the composer, within the limits of `POST /v1/sessions/ID/messages`
 * (docs/desktop/api.md, "Images"): four per message, 3.5 MiB each, PNG, JPEG, GIF or WebP. Larger
 * images and other formats the browser can decode are re-encoded before they are sent.
 */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

/** An image waiting in the composer: what is sent and a URL for its thumbnail. */
export interface Attachment extends ImageUpload {
  id: string;
  name: string;
}

export function dataUrl(image: { mediaType: string; data: string }): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function storedImageUrl(image: StoredImage): string {
  return dataUrl({ mediaType: image.mediaType, data: image.base64 });
}

/** What the "Sending…" bubble shows for a message. */
export function pendingText(text: string, images: number): string {
  if (images === 0) return text;
  const note = `[${images} image${images === 1 ? "" : "s"}]`;
  return text ? `${text}\n${note}` : note;
}

/** The image files among pasted or dropped items, and how many fit next to `held` attachments. */
export function pickImages<T extends { type: string }>(
  files: readonly T[],
  held: number,
): { take: T[]; dropped: number } {
  const images = files.filter((f) => f.type.startsWith("image/"));
  const room = Math.max(0, MAX_IMAGES - held);
  return { take: images.slice(0, room), dropped: Math.max(0, images.length - room) };
}

/** The type the file header shows, which the server checks; null for other formats. */
export function sniffType(head: Uint8Array): ImageMediaType | null {
  const starts = (bytes: number[], at = 0): boolean => bytes.every((b, i) => head[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

/** Re-encodes an image as JPEG, scaling it down until it fits the size limit. */
async function reencode(file: Blob): Promise<ImageUpload> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image format is not supported; use PNG, JPEG, GIF or WebP.");
  }
  try {
    let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      // JPEG has no alpha: paint transparent areas white rather than black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      if (blob && blob.size <= MAX_IMAGE_BYTES)
        return { mediaType: "image/jpeg", data: await base64Of(blob) };
      scale *= 0.7;
    }
  } finally {
    bitmap.close();
  }
  throw new Error("The image is too large to send.");
}

let counter = 0;

/** Reads a pasted or dropped file into an attachment. */
export async function readAttachment(file: File): Promise<Attachment> {
  const type = sniffType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  const upload =
    type && file.size <= MAX_IMAGE_BYTES
      ? { mediaType: type, data: await base64Of(file) }
      : await reencode(file);
  counter += 1;
  return { ...upload, id: `att-${counter}`, name: file.name || `image-${counter}` };
}

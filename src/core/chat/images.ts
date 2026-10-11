/**
 * Image attachments of a chat message outside the terminal UI: the limits the local API and the
 * headless CLI enforce, checking what a client sent, and the model content a message with images
 * becomes. The terminal UI attaches clipboard images the same way (`useChat.ts`).
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ImagePart, TextPart } from "ai";
import type { ImageAttachment } from "../../types/index.js";
import { compressImageForApi } from "../../utils/image-compress.js";

export type ImageMediaType = ImageAttachment["mediaType"];

export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
/** Images one message may carry. */
export const MAX_IMAGES_PER_MESSAGE = 4;
/**
 * Decoded size of one image: the size providers accept once base64-encoded, so stored images go
 * to the model as they are, also when a session's model messages are rebuilt from its transcript.
 */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
/** Request body limit of the endpoints that take images: four maximal images in base64 plus text. */
export const MAX_IMAGE_BODY_BYTES = 20 * 1024 * 1024;

export class ImageInputError extends Error {}

/** The media type the file header shows, or null for anything else. */
export function sniffImageType(data: Uint8Array): ImageMediaType | null {
  const starts = (bytes: number[], at = 0): boolean => bytes.every((b, i) => data[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** An image as a client sends it: base64 data and the media type it claims. */
export interface ImageInput {
  mediaType: string;
  data: string;
}

/**
 * Checks images a client sent and labels them `image-1`, `image-2`… in order. The data must be
 * plain base64 (no `data:` prefix) of a supported type whose header matches the claimed type.
 */
export function acceptImages(inputs: readonly ImageInput[]): ImageAttachment[] {
  if (inputs.length > MAX_IMAGES_PER_MESSAGE)
    throw new ImageInputError(`A message can carry at most ${MAX_IMAGES_PER_MESSAGE} images`);
  return inputs.map((input, i) => {
    const label = `image-${i + 1}`;
    if (!IMAGE_MEDIA_TYPES.includes(input.mediaType as ImageMediaType))
      throw new ImageInputError(
        `${label}: unsupported type ${input.mediaType}; use ${IMAGE_MEDIA_TYPES.join(", ")}`,
      );
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length % 4 !== 0)
      throw new ImageInputError(`${label}: data is not base64`);
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length === 0) throw new ImageInputError(`${label}: the image is empty`);
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new ImageInputError(`${label}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB`);
    const sniffed = sniffImageType(bytes);
    if (sniffed !== input.mediaType)
      throw new ImageInputError(
        `${label}: the data is ${sniffed ?? "not a supported image"}, not ${input.mediaType}`,
      );
    return { label, base64: input.data, mediaType: sniffed };
  });
}

/**
 * Reads image files for the headless CLI; the type comes from the file header. A file over the
 * size limit is recompressed to JPEG when a converter is installed (see `compressImageForApi`).
 */
export async function readImageFiles(paths: readonly string[]): Promise<ImageAttachment[]> {
  if (paths.length > MAX_IMAGES_PER_MESSAGE)
    throw new ImageInputError(`At most ${MAX_IMAGES_PER_MESSAGE} images per message`);
  const inputs: ImageInput[] = [];
  for (const path of paths) {
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      throw new ImageInputError(`Image not found: ${path}`);
    }
    const sniffed = sniffImageType(data);
    if (!sniffed)
      throw new ImageInputError(
        `${path}: not a PNG, JPEG, GIF or WebP image${extname(path) ? ` (${extname(path)})` : ""}`,
      );
    const fitted = await compressImageForApi(data, sniffed);
    if (fitted.data.length > MAX_IMAGE_BYTES)
      throw new ImageInputError(
        `${path}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB and could not be compressed (install ImageMagick or ffmpeg)`,
      );
    inputs.push({ mediaType: fitted.mediaType, data: fitted.data.toString("base64") });
  }
  return acceptImages(inputs);
}

/** Whether a stored image can go to the model without recompressing it. */
export function fitsModel(image: ImageAttachment): boolean {
  return Math.floor((image.base64.length * 3) / 4) <= MAX_IMAGE_BYTES;
}

/** The user content of a model message: the text alone, or the text followed by the images. */
export function userContent(
  text: string,
  images: readonly ImageAttachment[] | undefined,
): string | Array<TextPart | ImagePart> {
  if (!images || images.length === 0) return text;
  // Providers reject empty text blocks, and a message may be images alone.
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map(
      (img): ImagePart => ({ type: "image", image: img.base64, mediaType: img.mediaType }),
    ),
  ];
}

/**
 * Images in a prompt, for the CLI providers (Codex, Claude Code) that send a prompt as text and
 * pass images beside it. The SDK hands an image to a provider as a `file` part whose data is
 * bytes, base64, a data URL or a URL.
 */

export type PromptImage =
  | { mediaType: string; base64: string }
  /** An http(s) image the provider fetches itself. */
  | { mediaType: string; url: string };

interface PromptPartLike {
  type: string;
  mediaType?: string;
  data?: unknown;
}

const DATA_URL = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s;

/** The image a prompt part carries, or null when it is not an image. */
export function promptImage(part: PromptPartLike): PromptImage | null {
  if (part.type !== "file" || !part.mediaType?.startsWith("image/")) return null;
  const { data } = part;
  // `image/*` means the type is left to the provider; PNG is the common case.
  const mediaType = part.mediaType === "image/*" ? "image/png" : part.mediaType;
  if (data instanceof Uint8Array)
    return { mediaType, base64: Buffer.from(data).toString("base64") };
  const text = data instanceof URL ? data.toString() : typeof data === "string" ? data : null;
  if (text === null) return null;
  const inline = DATA_URL.exec(text);
  if (inline) return { mediaType: inline[1] ?? mediaType, base64: inline[2] ?? "" };
  if (/^https?:\/\//i.test(text)) return { mediaType, url: text };
  return { mediaType, base64: text };
}

/** Every image of the messages' content, in order. */
export function promptImages(
  messages: readonly { content: string | readonly PromptPartLike[] }[],
): PromptImage[] {
  const images: PromptImage[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      const image = promptImage(part);
      if (image) images.push(image);
    }
  }
  return images;
}

/** The image as a URL: its own http(s) URL, or a base64 data URL. */
export function imageUrl(image: PromptImage): string {
  return "url" in image ? image.url : `data:${image.mediaType};base64,${image.base64}`;
}

/** The transcript's stand-in for an image part; the image itself goes beside the text. */
export function imagePlaceholder(mediaType: string): string {
  return `[image ${mediaType}, attached to this message]`;
}

/** File extension for an image written to disk. */
export function imageExtension(mediaType: string): string {
  const sub = mediaType.split("/")[1] ?? "png";
  return sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "") || "png";
}

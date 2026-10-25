import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A minimal zip archive of text files: deflated entries, forward-slash names, a fixed timestamp
 * (1980-01-01) so the same files always give the same bytes. No ZIP64: an export holds far fewer
 * than 65535 files and 4 GiB.
 */
export function zipFiles(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = encoder.encode(path.replaceAll("\\", "/"));
    const raw = encoder.encode(content);
    const data = deflateRawSync(raw);
    const crc = Bun.hash.crc32(raw) >>> 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    // Bit 11: the name is UTF-8.
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * The text files of a zip archive `zipFiles` writes (stored or deflated entries), by name. Throws
 * on anything else: a ZIP64 or encrypted archive, a bad checksum, or more than `maxFiles` entries
 * or `maxBytes` unpacked bytes.
 */
export function unzipFiles(
  bytes: Uint8Array,
  limits: { maxFiles: number; maxBytes: number },
): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("not a zip archive");
  const count = view.getUint16(end + 10, true);
  if (count > limits.maxFiles) throw new Error(`more than ${limits.maxFiles} files`);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: Record<string, string> = {};
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      throw new Error("bad central directory");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error(`encrypted entry ${name}`);
    if (name.endsWith("/")) continue;
    total += size;
    if (total > limits.maxBytes) throw new Error(`more than ${limits.maxBytes} bytes unpacked`);
    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50)
      throw new Error(`bad entry ${name}`);
    const start =
      localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const data = bytes.subarray(start, start + packed);
    const raw =
      method === 0
        ? data
        : method === 8
          ? inflateRawSync(data, { maxOutputLength: limits.maxBytes })
          : null;
    if (!raw) throw new Error(`unsupported compression in ${name}`);
    if (raw.length !== size || Bun.hash.crc32(raw) >>> 0 !== crc)
      throw new Error(`checksum mismatch in ${name}`);
    files[name] = decoder.decode(raw);
  }
  return files;
}

/**
 * The grammars in tree-sitter-wasms 0.1.13 were built by an emscripten that wrote a legacy
 * `dylink` custom section. web-tree-sitter 0.26+ only reads its successor `dylink.0`, so it
 * rejects them before loading. The section carries the same fields in both formats (memory and
 * table sizes and alignments, then the needed libraries), so it is rewritten in memory.
 */
export function upgradeLegacyDylink(wasm: Uint8Array): Uint8Array {
  // The section must come first: a custom section (id 0) right after the 8-byte header.
  if (wasm.length < 10 || wasm[8] !== 0) return wasm;
  const at = { i: 9 };
  const size = readLeb(wasm, at);
  const end = at.i + size;
  if (readName(wasm, at) !== "dylink") return wasm;
  const memInfo = [
    readLeb(wasm, at),
    readLeb(wasm, at),
    readLeb(wasm, at),
    readLeb(wasm, at),
  ].flatMap(leb);
  const needed: string[] = [];
  for (let n = readLeb(wasm, at); n > 0; n--) needed.push(readName(wasm, at));

  const body = [...name("dylink.0"), WASM_DYLINK_MEM_INFO, ...leb(memInfo.length), ...memInfo];
  if (needed.length > 0) {
    const list = [...leb(needed.length), ...needed.flatMap(name)];
    body.push(WASM_DYLINK_NEEDED, ...leb(list.length), ...list);
  }
  const section = [0, ...leb(body.length), ...body];
  const out = new Uint8Array(8 + section.length + (wasm.length - end));
  out.set(wasm.subarray(0, 8));
  out.set(section, 8);
  out.set(wasm.subarray(end), 8 + section.length);
  return out;
}

const WASM_DYLINK_MEM_INFO = 1;
const WASM_DYLINK_NEEDED = 2;

function readLeb(bytes: Uint8Array, at: { i: number }): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = bytes[at.i++] ?? 0;
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

function readName(bytes: Uint8Array, at: { i: number }): string {
  const length = readLeb(bytes, at);
  const text = new TextDecoder().decode(bytes.subarray(at.i, at.i + length));
  at.i += length;
  return text;
}

function leb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

function name(text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  return [...leb(bytes.length), ...bytes];
}

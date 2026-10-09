/**
 * FNV-1a 32-bit hash. Fast, deterministic, good distribution for short strings.
 * Used wherever a cheap content fingerprint is needed (embeddings, cache keys,
 * snapshot identity). Not cryptographic.
 */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hash32Hex(s: string): string {
  return hash32(s).toString(16).padStart(8, "0");
}

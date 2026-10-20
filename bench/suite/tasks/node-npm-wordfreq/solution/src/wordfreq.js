export function topWords(text, n) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  if (!Number.isInteger(n) || n < 1) throw new TypeError("n must be a positive integer");
  const counts = new Map();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, n);
}

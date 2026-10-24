/**
 * Emphasis and strong emphasis of one line of Markdown inline text, rendered to HTML with
 * CommonMark's delimiter-run algorithm (spec 0.31, section 6.2 and "Phase 2: inline structure"):
 * delimiter runs of `*` and `_` go on a stack with their flanking flags, and each closer looks back
 * for the nearest matching opener, honouring the rule of 3.
 */

interface TextNode {
  kind: "text";
  value: string;
  prev: Node | null;
  next: Node | null;
}
interface EmphNode {
  kind: "em" | "strong";
  first: Node | null;
  last: Node | null;
  prev: Node | null;
  next: Node | null;
}
type Node = TextNode | EmphNode;

interface Delim {
  node: TextNode;
  ch: "*" | "_";
  count: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delim | null;
  next: Delim | null;
}

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const isSpace = (c: string): boolean => c === "" || /\s/u.test(c);
const isPunct = (c: string): boolean => c !== "" && /[\p{P}\p{S}]/u.test(c);

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function renderInline(text: string): string {
  const head: { first: Node | null; last: Node | null } = { first: null, last: null };
  const append = (node: Node) => {
    node.prev = head.last;
    if (head.last) head.last.next = node;
    else head.first = node;
    head.last = node;
  };
  let delims: Delim | null = null;
  let buffer = "";
  const flush = () => {
    if (buffer) append({ kind: "text", value: buffer, prev: null, next: null });
    buffer = "";
  };
  const chars = [...text];
  for (let i = 0; i < chars.length; ) {
    const c = chars[i] as string;
    if (c === "\\" && i + 1 < chars.length && ESCAPABLE.test(chars[i + 1] as string)) {
      buffer += chars[i + 1];
      i += 2;
      continue;
    }
    if (c !== "*" && c !== "_") {
      buffer += c;
      i++;
      continue;
    }
    let j = i;
    while (chars[j] === c) j++;
    const before = chars[i - 1] ?? "";
    const after = chars[j] ?? "";
    const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
    const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
    const canOpen = c === "*" ? left : left && (!right || isPunct(before));
    const canClose = c === "*" ? right : right && (!left || isPunct(after));
    flush();
    const node: TextNode = { kind: "text", value: c.repeat(j - i), prev: null, next: null };
    append(node);
    if (canOpen || canClose) {
      const delim: Delim = {
        node,
        ch: c,
        count: j - i,
        orig: j - i,
        canOpen,
        canClose,
        prev: delims,
        next: null,
      };
      if (delims) delims.next = delim;
      delims = delim;
    }
    i = j;
  }
  flush();

  const removeDelim = (d: Delim) => {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else delims = d.prev;
  };
  const unlink = (node: Node) => {
    if (node.prev) node.prev.next = node.next;
    else head.first = node.next;
    if (node.next) node.next.prev = node.prev;
    else head.last = node.prev;
  };

  let closer: Delim | null = delims;
  while (closer?.prev) closer = closer.prev;
  const bottoms = new Map<string, Delim | null>();
  while (closer) {
    if (!closer.canClose) {
      closer = closer.next;
      continue;
    }
    const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}`;
    const bottom = bottoms.has(key) ? bottoms.get(key) : null;
    let opener: Delim | null = closer.prev;
    let found = false;
    while (opener && opener !== bottom) {
      if (opener.ch === closer.ch && opener.canOpen) {
        const odd =
          (opener.canClose || closer.canOpen) &&
          (opener.orig + closer.orig) % 3 === 0 &&
          !(opener.orig % 3 === 0 && closer.orig % 3 === 0);
        if (!odd) {
          found = true;
          break;
        }
      }
      opener = opener.prev;
    }
    const old: Delim = closer;
    if (!found || !opener) {
      bottoms.set(key, old.prev);
      closer = old.next;
      if (!old.canOpen) removeDelim(old);
      continue;
    }
    const use = closer.count >= 2 && opener.count >= 2 ? 2 : 1;
    opener.count -= use;
    closer.count -= use;
    opener.node.value = opener.node.value.slice(use);
    closer.node.value = closer.node.value.slice(use);
    // Wrap the nodes between the opener and the closer.
    const emph: EmphNode = {
      kind: use === 2 ? "strong" : "em",
      first: opener.node.next === closer.node ? null : opener.node.next,
      last: closer.node.prev === opener.node ? null : closer.node.prev,
      prev: opener.node,
      next: closer.node,
    };
    if (emph.first) emph.first.prev = null;
    if (emph.last) emph.last.next = null;
    opener.node.next = emph;
    closer.node.prev = emph;
    // Delimiters between them are now inside the emphasis and match nothing.
    opener.next = closer;
    closer.prev = opener;
    if (opener.count === 0) {
      unlink(opener.node);
      removeDelim(opener);
    }
    if (closer.count === 0) {
      const next: Delim | null = closer.next;
      unlink(closer.node);
      removeDelim(closer);
      closer = next;
    }
  }

  const render = (first: Node | null): string => {
    let out = "";
    for (let node = first; node; node = node.next)
      out +=
        node.kind === "text"
          ? escapeHtml(node.value)
          : `<${node.kind}>${render(node.first)}</${node.kind}>`;
    return out;
  };
  return render(head.first);
}

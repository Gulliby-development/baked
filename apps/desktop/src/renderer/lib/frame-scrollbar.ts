/** The theme tokens the app's scrollbar is drawn with (styles/base.css). */
const TOKENS = [
  "--line-strong",
  "--ink",
  "--bg",
  "--fill-accent",
  "--border-w",
  "--radius",
] as const;
export type ScrollbarTokens = Record<(typeof TOKENS)[number], string>;

/** The current values of the scrollbar tokens, read from the app's root element. */
export function scrollbarTokens(root: Element = document.documentElement): ScrollbarTokens {
  const style = getComputedStyle(root);
  return Object.fromEntries(
    TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]),
  ) as ScrollbarTokens;
}

/**
 * The page with the app's scrollbar style put first in its head. A framed page cannot see the
 * app's stylesheet, so its scrollbar would be the system's; the rules go first and use only
 * `::-webkit-scrollbar` selectors, so a page that styles its own scrollbar keeps it.
 */
export function withAppScrollbar(html: string, tokens: ScrollbarTokens): string {
  // Values come from the app's own stylesheet; anything that could close the tag is dropped.
  const v = (name: keyof ScrollbarTokens): string => tokens[name].replace(/[<>{};]/g, "");
  const style = `<style data-baked-scrollbar>
::-webkit-scrollbar{width:14px;height:14px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${v("--line-strong")};background-clip:padding-box;border:${v("--border-w")} solid ${v("--ink")};border-radius:${v("--radius")};box-shadow:inset 0 0 0 2px ${v("--bg")}}
::-webkit-scrollbar-thumb:hover,::-webkit-scrollbar-thumb:active{background:${v("--fill-accent")}}
::-webkit-scrollbar-button,::-webkit-scrollbar-corner{display:none;background:transparent}
</style>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + style + html.slice(head.index + head[0].length)
    );
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + style + html.slice(doctype[0].length);
  return style + html;
}

import { KIT_CSS, KIT_GENERATOR_META, KIT_MADE_WITH } from "./css.js";

const OWN_STYLES = /<style[\s>]|<link[^>]+stylesheet|cdn\.tailwindcss\.com/i;

/** Whether a page brings no styles of its own, so the kit can style it. */
export const pageIsUnstyled = (html: string): boolean => !OWN_STYLES.test(html);

/**
 * Styles an artifact page with the BAKED kit: the stylesheet and generator tag go into its head
 * and the "Made with BAKED" mark at the end of its body. A page without head or body gets them.
 */
export function applyKitToPage(html: string): string {
  if (html.includes(KIT_GENERATOR_META) && html.includes('class="bk-made"')) return html;
  const head = `${KIT_GENERATOR_META}\n<style>\n${KIT_CSS}</style>\n`;
  let page = html;
  if (/<head[^>]*>/i.test(page)) page = page.replace(/<head[^>]*>/i, (tag) => `${tag}\n${head}`);
  else if (/<html[^>]*>/i.test(page))
    page = page.replace(/<html[^>]*>/i, (tag) => `${tag}\n<head>\n${head}</head>`);
  else if (/<body[^>]*>/i.test(page))
    page = page.replace(/<body[^>]*>/i, (tag) => `<head>\n${head}</head>\n${tag}`);
  else
    page = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${head}</head>\n<body>\n${page}\n</body>\n</html>\n`;
  if (/<\/body>/i.test(page)) {
    const at = page.search(/<\/body>(?![\s\S]*<\/body>)/i);
    return `${page.slice(0, at)}${KIT_MADE_WITH}\n${page.slice(at)}`;
  }
  return `${page}\n${KIT_MADE_WITH}\n`;
}

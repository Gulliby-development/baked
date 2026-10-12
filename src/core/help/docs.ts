import { BUNDLED_DOCS } from "./bundled-docs.js";

/** A heading and the text under it, up to the next heading of any level. */
export interface DocSection {
  heading: string;
  level: number;
  /** GitHub-style anchor of the heading, as used in `page.md#anchor` links. */
  anchor: string;
  /** Character offsets of the section in the page, heading line included. */
  start: number;
  end: number;
}

export interface DocPage {
  /** Path relative to `docs/`, e.g. `workflows/quick.md`. */
  path: string;
  title: string;
  text: string;
  sections: DocSection[];
}

export interface DocSearchHit {
  path: string;
  anchor: string;
  heading: string;
  pageTitle: string;
  score: number;
  snippet: string;
}

/** Output larger than this is cut, with a pointer to narrower sections. */
export const DOC_READ_LIMIT = 12_000;

const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from how i in is it its me my of on or should the there this to use what when where which who why with you your baked bake".split(
    " ",
  ),
);

function anchorOf(heading: string, seen: Map<string, number>): string {
  const base = heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function parseSections(text: string): DocSection[] {
  const sections: DocSection[] = [];
  const seen = new Map<string, number>();
  let fenced = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      const last = sections.at(-1);
      if (last) last.end = offset;
      const heading = match[2].trim();
      sections.push({
        heading,
        level: match[1].length,
        anchor: anchorOf(heading, seen),
        start: offset,
        end: text.length,
      });
    }
    offset += line.length + 1;
  }
  return sections;
}

function buildPage(path: string, text: string): DocPage {
  const sections = parseSections(text);
  const title = sections.find((s) => s.level === 1)?.heading ?? path;
  return { path, title, text, sections };
}

let pages: DocPage[] | null = null;

/** Every bundled documentation page, parsed once on first use. */
export function docPages(): DocPage[] {
  pages ??= BUNDLED_DOCS.map(([path, text]) => buildPage(path, text));
  return pages;
}

/** Drops common English endings so "configured" also finds "configuration"; terms match as substrings. */
function stem(term: string): string {
  const stemmed = term.replace(/(ations?|ings?|ed|es|s)$/, "");
  return stemmed.length >= 4 ? stemmed : term;
}

function tokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_/-]+/u)
        .flatMap((t) => [t, ...t.split(/[-_/]/)])
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
        .map(stem),
    ),
  ];
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The line that mentions the most query terms, as a one-line preview. */
function snippet(body: string, terms: string[]): string {
  let best = "";
  let bestHits = -1;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const lower = line.toLowerCase();
    const hits = terms.filter((t) => lower.includes(t)).length;
    if (hits > bestHits) {
      best = line;
      bestHits = hits;
    }
  }
  return best.length > 200 ? `${best.slice(0, 197)}...` : best;
}

/** Design notes and contributor pages rank below the user guides. */
const SECONDARY_PAGES = new Set([
  "bench-loop.md",
  "brand.md",
  "parity.md",
  "workflows/architecture.md",
  "workflows/v2-design.md",
]);

interface IndexedSection {
  page: DocPage;
  section: DocSection;
  heading: string;
  body: string;
}

let index: { sections: IndexedSection[]; avgLength: number } | null = null;

function searchIndex() {
  if (index) return index;
  const sections = docPages().flatMap((page) =>
    page.sections.map((section) => ({
      page,
      section,
      heading: section.heading.toLowerCase(),
      body: page.text.slice(section.start, section.end).toLowerCase(),
    })),
  );
  const avgLength = sections.reduce((sum, s) => sum + s.body.length, 0) / (sections.length || 1);
  index = { sections, avgLength };
  return index;
}

/**
 * Sections ranked by BM25 over their text, with matches in the heading and page title counted
 * extra, so a section about the topic beats a long section that mentions it in passing.
 */
export function searchDocs(query: string, limit = 8): DocSearchHit[] {
  const terms = tokens(query);
  if (terms.length === 0) return [];
  const { sections, avgLength } = searchIndex();
  const idf = new Map(
    terms.map((term) => {
      const df = sections.filter((s) => s.body.includes(term)).length;
      return [term, Math.log(1 + (sections.length - df + 0.5) / (df + 0.5))];
    }),
  );
  const phrase = query.trim().toLowerCase();
  const hits: DocSearchHit[] = [];
  for (const { page, section, heading, body } of sections) {
    const pageKey = `${page.path} ${page.title}`.toLowerCase();
    const norm = 1.2 * (0.25 + 0.75 * (body.length / avgLength));
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const weight = idf.get(term) ?? 0;
      const tf = countOf(body, term);
      const inHeading = heading.includes(term);
      if (tf > 0 || inHeading) matched++;
      score += weight * ((tf * 2.2) / (tf + norm) + (inHeading ? 2 : 0));
      if (pageKey.includes(term)) score += weight * 0.5;
    }
    if (matched === 0) continue;
    // Sections that match more of the question beat sections that repeat one word.
    score *= (matched / terms.length) ** 2;
    if (phrase.length > 3 && body.includes(phrase)) score *= 1.5;
    if (SECONDARY_PAGES.has(page.path)) score *= 0.5;
    hits.push({
      path: page.path,
      anchor: section.anchor,
      heading: section.heading,
      pageTitle: page.title,
      score,
      snippet: snippet(page.text.slice(section.start, section.end), terms),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A page by its path (`docs/` prefix and `.md` optional) or title; `null` when none matches. */
export function findDocPage(name: string): DocPage | null {
  const key = name
    .trim()
    .replace(/\\/g, "/")
    .replace(/#.*$/, "")
    .replace(/^\.?\/?docs\//, "")
    .toLowerCase();
  const all = docPages();
  return (
    all.find((p) => p.path.toLowerCase() === key) ??
    all.find((p) => p.path.toLowerCase() === `${key}.md`) ??
    all.find((p) => p.path.toLowerCase() === `${key}/readme.md`) ??
    all.find((p) => p.title.toLowerCase() === key) ??
    all.find((p) => p.path.toLowerCase().replace(/\.md$/, "").endsWith(`/${key}`)) ??
    null
  );
}

/** The section, with its subsections, whose anchor or heading matches `name`. */
export function findDocSection(page: DocPage, name: string): DocSection | null {
  const key = name.trim().replace(/^#/, "").toLowerCase();
  const index =
    [
      page.sections.findIndex((s) => s.anchor === key),
      page.sections.findIndex((s) => s.heading.toLowerCase() === key),
      page.sections.findIndex((s) => s.heading.toLowerCase().includes(key)),
    ].find((i) => i !== -1) ?? -1;
  const section = page.sections[index];
  if (!section) return null;
  const next = page.sections.slice(index + 1).find((s) => s.level <= section.level);
  return { ...section, end: next?.start ?? page.text.length };
}

function outline(page: DocPage): string {
  const deep = page.sections.filter((s) => s.level === 3).length;
  const maxLevel = deep > 40 ? 2 : 3;
  return page.sections
    .filter((s) => s.level >= 2 && s.level <= maxLevel)
    .map((s) => `${"  ".repeat(s.level - 2)}- ${s.heading} (#${s.anchor})`)
    .join("\n");
}

function cut(text: string, page: DocPage): string {
  if (text.length <= DOC_READ_LIMIT) return text;
  return `${text.slice(0, DOC_READ_LIMIT)}\n\n[... cut at ${DOC_READ_LIMIT} characters. Read a narrower section of ${page.path}:]\n${outline(page)}`;
}

/** Text of a page or one of its sections, cut to `DOC_READ_LIMIT` with an outline to read further. */
export function readDoc(
  name: string,
  sectionName?: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const page = findDocPage(name);
  if (!page) {
    return {
      ok: false,
      error: `No documentation page "${name}". Pages: ${docPages()
        .map((p) => p.path)
        .join(", ")}`,
    };
  }
  const anchor = sectionName ?? (name.includes("#") ? name.slice(name.indexOf("#") + 1) : "");
  if (anchor) {
    const section = findDocSection(page, anchor);
    if (!section) {
      return {
        ok: false,
        error: `No section "${anchor}" in ${page.path}. Sections:\n${outline(page)}`,
      };
    }
    return {
      ok: true,
      text: `[${page.path}#${section.anchor}]\n${cut(page.text.slice(section.start, section.end), page)}`,
    };
  }
  return { ok: true, text: `[${page.path}]\n${cut(page.text, page)}` };
}

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { KIT_FILE } from "./css.js";

/**
 * What a project says about its own look, decided from files only (never by the model):
 * - `styled`: it has styles of its own, or its instruction files talk about design; the kit stays out.
 * - `kit`: its only stylesheet is the BAKED kit, so new UI keeps to it.
 * - `unstyled`: a web project (or an empty one) with no styles; the kit is offered.
 * - `not-web`: code with no web front end; nothing to style.
 */
export type ProjectStyle =
  | { state: "styled"; reason: string }
  | { state: "kit"; path: string }
  | { state: "unstyled"; reason: string }
  | { state: "not-web" };

/** Dependencies that bring a look of their own: CSS frameworks, component kits, CSS-in-JS. */
const STYLE_PACKAGES = [
  "tailwindcss",
  "@tailwindcss/vite",
  "@tailwindcss/postcss",
  "unocss",
  "bootstrap",
  "bulma",
  "daisyui",
  "@mui/material",
  "@mui/joy",
  "@chakra-ui/react",
  "@mantine/core",
  "antd",
  "@radix-ui/themes",
  "@nextui-org/react",
  "@heroui/react",
  "primereact",
  "vuetify",
  "element-plus",
  "quasar",
  "@picocss/pico",
  "styled-components",
  "@emotion/react",
  "@emotion/styled",
  "@vanilla-extract/css",
  "@pandacss/dev",
  "@stitches/react",
  "sass",
  "less",
  "stylus",
];
const CONFIG_FILES = /^(tailwind|uno|postcss|panda)\.config\.[cm]?[jt]s$|^components\.json$/;
const STYLESHEET = /\.(css|scss|sass|less|styl|pcss)$/i;
const WEB_FILE = /\.(html?|jsx|tsx|vue|svelte|astro|erb|ejs|hbs|njk|jinja2?|twig|razor|cshtml)$/i;
const MARKUP_FILE = /\.(html?|vue|svelte|astro)$/i;
const INLINE_STYLES = /<style[\s>]|rel=["']?stylesheet|cdn\.tailwindcss\.com/i;
/** Files a brand-new project may already have without having any code yet. */
const EMPTY_PROJECT_FILE =
  /^(readme|license|licence|changelog|contributing|agents|claude|gemini|baked)(\.[a-z]+)?$/i;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  ".baked",
  "baked",
]);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 4000;
/** Instruction text that already decides the look: the kit must not compete with it. */
const DESIGN_WORDS =
  /\b(css|scss|tailwind|styl(e|es|ed|ing)|design system|design tokens?|theme|branding|brand colou?rs?|colou?r palette|typography|fonts?|ui kit)\b/i;

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function styleDependency(cwd: string): string | null {
  const pkg = readJson(join(cwd, "package.json"));
  if (!pkg) return null;
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
  }
  return STYLE_PACKAGES.find((name) => names.has(name)) ?? null;
}

function hasInlineStyles(path: string): boolean {
  try {
    return INLINE_STYLES.test(readFileSync(path, "utf8").slice(0, 200_000));
  } catch {
    return false;
  }
}

interface Scan {
  stylesheets: string[];
  web: boolean;
  config: string | null;
  /** A page or component file with its own `<style>` block or stylesheet link. */
  inline: string | null;
  /** Files that are neither dotfiles nor the usual first files of a new project. */
  code: number;
}

function scan(cwd: string): Scan {
  const result: Scan = {
    stylesheets: [],
    web: false,
    config: null,
    inline: null,
    code: 0,
  };
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return;
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (depth === 0 && EMPTY_PROJECT_FILE.test(entry.name)) continue;
      result.code++;
      if (depth === 0 && !result.config && CONFIG_FILES.test(entry.name))
        result.config = entry.name;
      if (STYLESHEET.test(entry.name)) result.stylesheets.push(relative(cwd, path));
      else if (WEB_FILE.test(entry.name)) {
        result.web = true;
        if (!result.inline && MARKUP_FILE.test(entry.name) && hasInlineStyles(path))
          result.inline = relative(cwd, path);
      }
    }
  };
  walk(cwd, 0);
  return result;
}

/** Decides how the kit applies to `cwd`; `instructions` is the project's instruction text. */
export function detectProjectStyle(cwd: string, instructions = ""): ProjectStyle {
  const words = instructions.match(DESIGN_WORDS);
  if (words) return { state: "styled", reason: `the instruction files mention "${words[0]}"` };
  const dependency = styleDependency(cwd);
  if (dependency) return { state: "styled", reason: `package.json depends on ${dependency}` };
  const found = scan(cwd);
  if (found.config) return { state: "styled", reason: `the project has ${found.config}` };
  const own = found.stylesheets.filter((path) => !path.endsWith(KIT_FILE));
  if (own.length > 0) return { state: "styled", reason: `the project has ${own[0]}` };
  const kit = found.stylesheets.find((path) => path.endsWith(KIT_FILE));
  if (kit) return { state: "kit", path: kit };
  if (found.code === 0) return { state: "unstyled", reason: "the project is empty" };
  if (found.inline) return { state: "styled", reason: `${found.inline} has styles of its own` };
  if (found.web) return { state: "unstyled", reason: "web files without any stylesheet" };
  return { state: "not-web" };
}

import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../../config/index.js";
import { KIT_CLASSES, KIT_CSS, KIT_FILE } from "./css.js";
import { detectProjectStyle, type ProjectStyle } from "./detect.js";

/** `designKit`: `auto` offers the kit to unstyled web projects, `always` to every project. */
export type DesignKitMode = "auto" | "off" | "always";

export function designKitMode(cwd: string): DesignKitMode {
  try {
    const value = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(cwd)).designKit;
    return value === "off" || value === "always" ? value : "auto";
  } catch {
    return "auto";
  }
}

const RULES = `- Save the stylesheet below as \`${KIT_FILE}\` where the pages can load it (next to them, or in the app's static or public folder) and link it before any other CSS. Keep it unchanged; put project-specific CSS in a separate file, and rebrand by overriding the --bk-* variables there.
- Write semantic HTML: the kit styles plain elements (headings, links, buttons, forms, tables, code). For layout and components use ${KIT_CLASSES}.
- Add <meta name="generator" content="BAKED"> to the head of each page. Do not add visible BAKED branding unless the user asks for it.
- The user's request comes first: if they ask for another look, a CSS framework or their own brand, follow them and leave the kit out. Do not add the kit to work that has no web UI.`;

const fenced = `\`\`\`css\n${KIT_CSS}\`\`\``;

/**
 * The design guidance for the agent's context, or "" when none applies. Provider-agnostic: it
 * reads as a project instruction. The stylesheet is included only where the agent may need to
 * add it, so styled projects cost nothing.
 */
export function buildKitGuidance(mode: DesignKitMode, style: ProjectStyle): string {
  if (mode === "off") return "";
  if (style.state === "kit")
    return `Design (BAKED kit): this project is styled with the BAKED kit (\`${style.path}\`). Keep new UI consistent with it: reuse its classes (${KIT_CLASSES}) and its --bk-* variables, put extra CSS in a separate file and leave the kit file unchanged. The user's request for another look comes first.`;
  if (mode === "always")
    return `Design (BAKED kit): the user chose the BAKED kit as the default look for web UI. Use it for new pages and new UI; keep existing screens in the style they already have unless the user asks to restyle them.\n${RULES}\n${fenced}`;
  if (style.state !== "unstyled") return "";
  return `Design (BAKED kit): this project has no styling of its own (${style.reason}) and its instruction files say nothing about design. When you build a web page or web UI here, style it with the BAKED kit instead of inventing a style or leaving it unstyled.\n${RULES}\n${fenced}`;
}

/** The guidance for `cwd` under its configured `designKit` mode. */
export function kitGuidanceFor(cwd: string, instructions = ""): string {
  const mode = designKitMode(cwd);
  if (mode === "off") return "";
  return buildKitGuidance(mode, detectProjectStyle(cwd, instructions));
}

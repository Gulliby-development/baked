import type { PackageKind } from "../../client/packages.js";

/** The package kinds in the order a package lists them. */
export const PACKAGE_KINDS: PackageKind[] = ["agents", "skills", "workflows", "gates"];

const KIND_WORDS: Record<PackageKind, [string, string]> = {
  agents: ["agent profile", "agent profiles"],
  skills: ["skill", "skills"],
  workflows: ["workflow", "workflows"],
  gates: ["gate", "gates"],
};

/** One thing a package carries, drawn as a tile that goes into the box. */
export interface BoxItem {
  key: string;
  kind: PackageKind;
  name: string;
}

/** The tiles the box shows at most; the rest are counted on the last one. */
export const BOX_SLOTS = 6;

/** A package's contents as box tiles, in kind order. */
export function boxItems(contents: Record<PackageKind, string[]>): BoxItem[] {
  return PACKAGE_KINDS.flatMap((kind) =>
    contents[kind].map((name) => ({ key: `${kind}/${name}`, kind, name })),
  );
}

/** "1 agent profile · 2 skills · 1 gate"; empty for an empty package. */
export function contentsLine(contents: Record<PackageKind, string[]>): string {
  return PACKAGE_KINDS.filter((k) => contents[k].length)
    .map((k) => {
      const n = contents[k].length;
      return `${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`;
    })
    .join(" · ");
}

/** Time between two tiles leaving for the box, and the fall of one tile. */
export const DROP_GAP_MS = 260;
export const DROP_MS = 620;

/** How long the box takes to shut, tape and stamp its sticker (PackageBox's delays). */
export const CLOSE_MS = 1200;

/** How long the tiles take to land in the box: none when the system asks for reduced motion. */
export function packingMs(count: number, reduced: boolean): number {
  if (reduced || count === 0) return 0;
  return (Math.min(count, BOX_SLOTS) - 1) * DROP_GAP_MS + DROP_MS + 120;
}

/** Whether the system asks for reduced motion; false outside a browser. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The steps of the two package dialogs. */
export const INSTALL_STEPS = [
  { step: "folder", title: "Folder" },
  { step: "plan", title: "Plan" },
  { step: "done", title: "Installed" },
] as const;
export const CREATE_STEPS = [
  { step: "folder", title: "Folder" },
  { step: "details", title: "Name and version" },
  { step: "done", title: "Packed" },
] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number]["step"];
export type CreateStep = (typeof CREATE_STEPS)[number]["step"];

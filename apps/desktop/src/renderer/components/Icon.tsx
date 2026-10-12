/** The BAKED line icons on a 24px grid; each is one stroked path. See docs/brand.md. */
const PATHS = {
  overview: "M3 3h18v18H3zM3 8h18M6 5.5h1M9 5.5h1M7 12h10v5H7z",
  chat: "M3 4h18v12H10l-5 4v-4H3zM7 8.5h10M7 12h6",
  runs: "M2.5 17c0-3 1.1-5 2.5-5s2.5 2 2.5 5zM9.5 17c0-3 1.1-5 2.5-5s2.5 2 2.5 5zM16.5 17c0-3 1.1-5 2.5-5s2.5 2 2.5 5zM1.5 17h21v3h-21z",
  initiatives: "M5 3h14l-3 4.5 3 4.5H5zM5 3v19",
  acceptance:
    "M8.5 14.5L6.5 22l3-1.2L12 23l2.5-2.2 3 1.2-2-7.5zM5 9a7 7 0 1 0 14 0a7 7 0 1 0 -14 0zM9 9l2 2 4-4",
  usage:
    "M3.5 4h14l-1.5 15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM17.2 7.5H21v7h-4.3M8.5 9h3M8.5 13h5M8.5 17h3",
  graph: "M3 3h6v6H3zM15 3h6v6h-6zM9 15h6v6H9zM9 6h6M6 9l5 6M18 9l-5 6",
  git: "M6 3v12M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0zM15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0zM18 9a9 9 0 0 1-9 9",
  gates: "M10 4a2 2 0 0 1 4 0v10.3a4 4 0 1 1-4 0zM12 9v8M17 6h2M17 9.5h2M17 13h2",
  instructions: "M4 3h12l4 4v14H4zM16 3v4h4M8 11h8M8 14h8M8 17h5",
  "working-set": "M2 11h20c0 5-4 9-10 9S2 16 2 11zM8 22h8M6 11c1.2-2.4 3.2-3.5 6-3.5M15 9l4-6.5",
  "run-memory":
    "M6 7h12v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM5 3h14v4H5zM6 11h12M9 15a1 1 0 1 0 2 0a1 1 0 1 0 -2 0zM13 17.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0z",
  "chat-memory": "M3 4h18v12H10l-5 4v-4H3zM7 8.5h4M7 12h3M15 7.5v5M13 8.5l4 3M17 8.5l-4 3",
  diagnostics: "M3 4h18v16H3zM3 12h4l2-4 3 8 2.5-5 1.5 1H21",
  skills: "M5 3h11l3 3v15H5zM9 13.5l1.8-.6.7-1.9.7 1.9 1.8.6-1.8.6-.7 1.9-.7-1.9zM9 8h6",
  hooks: "M14 3v9a5 5 0 0 1-10 0v-2M4 10l-2 2M4 10l2 2M14 3h-3M17 6h4M17 10h4M17 14h4",
  mcp: "M8 3v5M16 3v5M5 8h14v4a7 7 0 0 1-14 0zM12 19v3",
  lsp: "M8 3C6 3 5 4 5 6v3c0 1.5-1 3-3 3 2 0 3 1.5 3 3v3c0 2 1 3 3 3M16 3c2 0 3 1 3 3v3c0 1.5 1 3 3 3-2 0-3 1.5-3 3v3c0 2-1 3-3 3M9 12h1M14 12h1",
  attention: "M3.5 17a8.5 8.5 0 0 1 17 0zM2 17h20v3H2zM12 5v3.5M9.5 5h5",
  projects: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  settings: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0zM12 12l4-4M12 1.5v1.5M22.5 12H21M1.5 12H3",
  new: "M12 4v16M4 12h16",
  undo: "M9 5L4 10l5 5M4 10h11a5 5 0 0 1 0 10h-3",
  redo: "M15 5l5 5-5 5M20 10H9a5 5 0 0 0 0 10h3",
  send: "M12 20V4M5 11l7-7 7 7",
  stop: "M6 6h12v12H6z",
  export: "M12 4v11M7 10l5 5 5-5M4 20h16",
  delete: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  "chevron-right": "M9 5l7 7-7 7",
  "chevron-down": "M5 9l7 7 7-7",
  // Workflow stages.
  research:
    "M12 6.5C10.3 5.2 10 3.2 12 1c2 2.2 1.7 4.2 0 5.5zM12 11.5c-3 0-5-2-5-4 3 0 5 2 5 4zM12 11.5c3 0 5-2 5-4-3 0-5 2-5 4zM12 16.5c-3 0-5-2-5-4 3 0 5 2 5 4zM12 16.5c3 0 5-2 5-4-3 0-5 2-5 4zM12 6.5V23",
  spec: "M4 3h16v18H4zM8 7.5h8M8 11h5M8 15.5l2 2 4-4",
  plan: "M2.5 15c0-5.5 4.3-9 9.5-9s9.5 3.5 9.5 9v3h-19zM7 14l3-4.5M11 14l3-4.5M15 14l3-4.5",
  implement:
    "M9.5 14.5c-1.5-4.5 1.5-10 6.5-12 4 1.5 6 5 5.5 8-2.5 4-7 5.5-12 4zM9.5 14.5l-7 7M9.5 14.5c3-2.5 6-6.5 8-10M9.5 14.5c4-1 8-3 10.5-6.5",
  checks: "M10 4a2 2 0 0 1 4 0v10.3a4 4 0 1 1-4 0zM12 9v8M17 6h2M17 9.5h2M17 13h2",
  review:
    "M13.5 11c-2.5-2.5-2.5-6.5.5-8.5s6.5-.5 7.5 2-1 6.5-4.5 7.5c-1.5.5-2.5 0-3.5-1zM13.5 11l-10 10",
  accept:
    "M8.5 14.5L6.5 22l3-1.2L12 23l2.5-2.2 3 1.2-2-7.5zM5 9a7 7 0 1 0 14 0a7 7 0 1 0 -14 0zM9 9l2 2 4-4",
  // Status.
  ok: "M3 3h18v18H3zM7 12l3.5 3.5L17 9",
  failed: "M3 3h18v18H3zM8 8l8 8M16 8l-8 8",
  waiting: "M6 3h12v2.5L14 12l4 6.5V21H6v-2.5L10 12 6 5.5zM9 18h6",
  warning: "M12 2.5L22.5 21h-21zM12 9v6M12 17.5v1.5",
  running: "M12 3a9 9 0 1 1-9 9M10.8 3a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0z",
  // Chat tools.
  read: "M2 5h7.5A2.5 2.5 0 0 1 12 7.5V20a2 2 0 0 0-2-2H2zM22 5h-7.5A2.5 2.5 0 0 0 12 7.5V20a2 2 0 0 1 2-2h8z",
  edit: "M15 3l6 6-12 12H3v-6zM12 6l6 6",
  shell: "M2 4h20v16H2zM6 9l3 3-3 3M11.5 15H18",
  search: "M3.5 10a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0zM15 15l6.5 6.5",
  image: "M3 4h18v16H3zM3 16.5l5-5 4 4 3-3 6 6M14.5 8.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0z",
  fork: "M6 3v5c0 3.5 6 3.5 6 7v6M18 3v5c0 3.5-6 3.5-6 7",
  rewind: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4 3.5V8h4.5M12 8v4l3 2",
  compact: "M6 9h12v6H6zM1.5 12H6M18 12h4.5M9 9v6M12 9v6M15 9v6",
  model:
    "M6 6h12v12H6zM9 2.5V6M12 2.5V6M15 2.5V6M9 18v3.5M12 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5M9.5 9.5h5v5h-5z",
} as const;

export type IconName = keyof typeof PATHS;

/**
 * Block-style parts: the closed shapes that take the accent fill and the hard shadow, and the
 * open strokes drawn over them. Only icons used in the block style are listed.
 */
const BLOCKS = {
  projects: { fill: PATHS.projects, line: "" },
  runs: { fill: PATHS.runs, line: "" },
  chat: { fill: "M3 4h18v12H10l-5 4v-4H3z", line: "M7 8.5h10M7 12h6" },
} as const;

export type BlockIconName = keyof typeof BLOCKS;

/** A BAKED line icon drawn in the current text colour. */
export function Icon({
  name,
  size = 15,
  filled = false,
  className,
}: {
  name: IconName;
  size?: number;
  /** Fills the shape with the current colour, for solid glyphs such as Stop. */
  filled?: boolean;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeMiterlimit="3"
      aria-hidden="true"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * A BAKED icon in the block style for large places such as empty states: the shape filled with
 * the accent, an ink outline and a 1.5px hard ink shadow.
 */
export function BlockIcon({
  name,
  size = 40,
  className,
}: {
  name: BlockIconName;
  size?: number;
  className?: string;
}) {
  const { fill, line } = BLOCKS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="-0.5 -0.5 26 26"
      stroke="var(--ink)"
      strokeWidth="2"
      strokeLinecap="square"
      strokeMiterlimit="3"
      aria-hidden="true"
      className={className}
    >
      <path d={fill} transform="translate(1.5 1.5)" fill="var(--ink)" />
      <path d={fill} fill="var(--fill-accent)" />
      {line && <path d={line} fill="none" />}
    </svg>
  );
}

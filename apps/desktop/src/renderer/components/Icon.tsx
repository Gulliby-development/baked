/** The BAKED line icons on a 24px grid; each is one stroked path. Sources: docs/assets/brand. */
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
  skills: "M5 3h11l3 3v15H5zM9 13.5l1.8-.6.7-1.9.7 1.9 1.8.6-1.8.6-.7 1.9-.7-1.9zM9 8h6",
  attention: "M3.5 17a8.5 8.5 0 0 1 17 0zM2 17h20v3H2zM12 5v3.5M9.5 5h5",
  projects: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  settings: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0zM12 12l4-4M12 1.5v1.5M22.5 12H21M1.5 12H3",
  new: "M12 4v16M4 12h16",
  undo: "M9 5L4 10l5 5M4 10h11a5 5 0 0 1 0 10h-3",
  redo: "M15 5l5 5-5 5M20 10H9a5 5 0 0 0 0 10h3",
  send: "M12 20V4M5 11l7-7 7 7",
  stop: "M6 6h12v12H6z",
  "chevron-right": "M9 5l7 7-7 7",
  "chevron-down": "M5 9l7 7 7-7",
} as const;

export type IconName = keyof typeof PATHS;

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

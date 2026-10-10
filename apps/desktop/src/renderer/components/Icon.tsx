const PATHS = {
  bell: "M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3",
  grid: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  home: "M2.5 7.5L8 3l5.5 4.5V13h-11z",
  chat: "M2 3h12v8H6l-4 3z",
  runs: "M4.5 8h2M9.5 8h2",
  flag: "M3 2v12M3 3h9l-2 3 2 3H3",
  shield: "M8 2l5 2v4c0 3-2.5 5-5 6-2.5-1-5-3-5-6V4zM6 8l1.5 1.5L10.5 6",
  bars: "M3 13V8M8 13V3M13 13v-6",
  gate: "M3 14V4l5-2 5 2v10M6 14V9h4v5",
  file: "M4 2h6l3 3v9H4zM6 8h5M6 11h5",
  folder: "M3 4h4l1 1.5h5V13H3z",
  plus: "M8 3v10M3 8h10",
  gear: "M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2",
  panel: "M2 3h12v10H2zM6 3v10",
} as const;

export type IconName = keyof typeof PATHS;

/** Stroke icons from the mockups, drawn in the current text color. */
export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {name === "runs" && (
        <>
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </>
      )}
      {name === "gear" && <circle cx="8" cy="8" r="2.5" />}
      <path d={PATHS[name]} />
    </svg>
  );
}

import { useId } from "react";

/** The BAKED oven logo as a one-colour glyph in the current text colour; door and knobs are cut out. */
export function BakedMark({ size = 18, className }: { size?: number; className?: string }) {
  const mask = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <mask id={mask}>
        <rect width="64" height="64" fill="#fff" />
        <g fill="#000">
          <rect x="5" y="20" width="54" height="5" />
          <rect x="12" y="30" width="40" height="22" rx="2" />
          <circle cx="16" cy="12.5" r="4" />
          <circle cx="28" cy="12.5" r="4" />
        </g>
      </mask>
      <rect x="5" y="5" width="54" height="54" rx="7" fill="currentColor" mask={`url(#${mask})`} />
      <path
        d="M18 35l6 5-6 5M29 47h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="square"
      />
    </svg>
  );
}

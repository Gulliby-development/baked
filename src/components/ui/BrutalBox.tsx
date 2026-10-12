import type { ReactNode } from "react";
import { useTheme } from "../../core/theme/index.js";
import { artPalette } from "../../core/utils/bake-art.js";

// Wider than any terminal; the bottom row clips it to the frame's width.
const SHADOW_RUN = "▀".repeat(512);

/**
 * The neobrutalist hard shadow: a full-block column down the right side (from the second row)
 * and a half-block row underneath, both offset one cell. It adds one column and one row to
 * whatever it wraps; `width` is the outer width including the shadow (a number or `100%`).
 */
export function HardShadow({
  width,
  height,
  color,
  children,
}: {
  width?: number | `${number}%`;
  height?: number;
  color?: string;
  children: ReactNode;
}) {
  const t = useTheme();
  const shadow = color ?? artPalette(t).shadow;
  return (
    <box flexDirection="column" width={width} height={height} flexShrink={0}>
      <box flexDirection="row" flexGrow={height === undefined ? 0 : 1} flexShrink={1} minHeight={0}>
        <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          {children}
        </box>
        <box flexDirection="column" width={1} flexShrink={0}>
          <box height={1} flexShrink={0} />
          <box flexGrow={1} backgroundColor={shadow} />
        </box>
      </box>
      <box flexDirection="row" height={1} flexShrink={0} overflow="hidden">
        <box width={1} flexShrink={0} />
        <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={shadow} wrapMode="none">
            {SHADOW_RUN}
          </text>
        </box>
      </box>
    </box>
  );
}

/**
 * A neobrutalist card: heavy outline and a hard one-cell shadow on the right and bottom.
 * `width` and `height` are the outline's size; the shadow adds one column and one row.
 */
export function BrutalBox({
  width,
  height,
  title,
  borderColor,
  children,
}: {
  width: number;
  height: number;
  title?: string;
  borderColor?: string;
  children: ReactNode;
}) {
  const t = useTheme();
  return (
    <HardShadow width={width + 1} height={height + 1}>
      <box
        width={width}
        height={height}
        border
        borderStyle="heavy"
        borderColor={borderColor ?? t.textPrimary}
        title={title ? ` ${title} ` : undefined}
        flexDirection="column"
        paddingX={1}
      >
        {children}
      </box>
    </HardShadow>
  );
}

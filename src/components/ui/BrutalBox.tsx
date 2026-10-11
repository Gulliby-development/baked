import type { ReactNode } from "react";
import { useTheme } from "../../core/theme/index.js";
import { artPalette } from "../../core/utils/bake-art.js";

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
  const shadow = artPalette(t).shadow;
  return (
    <box flexDirection="column" width={width + 1} height={height + 1} flexShrink={0}>
      <box flexDirection="row" height={height}>
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
        <box flexDirection="column" width={1} height={height}>
          <text> </text>
          <text fg={shadow} wrapMode="none">
            {Array.from({ length: height - 1 }, () => "█").join("\n")}
          </text>
        </box>
      </box>
      <text fg={shadow} wrapMode="none">
        {` ${"▀".repeat(width)}`}
      </text>
    </box>
  );
}

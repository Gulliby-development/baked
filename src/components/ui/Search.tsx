import { memo, useState } from "react";
import { icon as iconFn } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";

const BOLD = 1;

export interface SearchProps {
  /** Current query value (controlled). Caller owns the state + key handling. */
  value: string;
  /** Shown when value is empty. Rendered dim + italic. */
  placeholder?: string;
  /** Focused = user is typing. Shows accent border + cursor block. */
  focused?: boolean;
  /** Right-aligned counter. Rendered in muted text. e.g. `3 / 127`. */
  count?: string;
  bg?: string;
  /** Leading icon name from core/icons.ts. Default: "search". */
  icon?: string;
}

/**
 * Search input — presentational. Caller owns the value and wires up the
 * keyboard handler (append char, backspace, etc.) on the parent popup.
 *
 *  ┌─  query text▎                                      3 / 127 ┐
 *  └─────────────────────────────────────────────────────────────┘
 *
 * Cursor behavior:
 *  - focused + empty  → cursor at start, placeholder shown dimmer after
 *  - focused + value  → cursor at end of value
 *  - unfocused        → no cursor
 */
export const Search = memo(function Search({
  value,
  placeholder = "Search…",
  focused,
  count,
  bg,
  icon = "search",
}: SearchProps) {
  const t = useTheme();
  const fill = bg ?? t.bgInput ?? t.bgPopup;
  const border = focused ? t.brandSecondary : t.border;
  const empty = value.length === 0;
  const [fieldWidth, setFieldWidth] = useState(60);
  const available = Math.max(1, fieldWidth - 7 - (count ? Bun.stringWidth(count) + 1 : 0));
  let displayed = value;
  while (Bun.stringWidth(displayed) > available) displayed = displayed.slice(1);
  return (
    <box
      onSizeChange={function () {
        setFieldWidth(this.width);
      }}
      flexDirection="row"
      borderStyle="rounded"
      border={true}
      borderColor={border}
      paddingX={1}
      height={3}
      backgroundColor={fill}
      flexShrink={0}
    >
      <text bg={fill} fg={focused ? t.brandSecondary : t.textMuted} attributes={BOLD}>
        {iconFn(icon)}
      </text>
      <text bg={fill}> </text>

      <text bg={fill} flexGrow={1} minWidth={0} wrapMode="none" truncate>
        <span fg={empty ? t.textMuted : t.textPrimary}>
          {empty ? (focused ? "▎" : "") + placeholder : displayed}
        </span>
        {!empty && focused ? <span fg={t.brandSecondary}>▎</span> : null}
      </text>

      {count ? (
        <text bg={fill} fg={t.textMuted} flexShrink={0}>
          {count}
        </text>
      ) : null}
    </box>
  );
});

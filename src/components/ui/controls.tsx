import { memo } from "react";
import { useTheme } from "../../core/theme/index.js";
import { FocusTarget } from "./FocusTarget.js";

const BOLD = 1;

// ── Button ─────────────────────────────────────────────────────────────────
// One-line actionable row. Focus indicated by brand border + brand label color.
// Use for: "Save", "Install", "Retry", "Connect".

export interface ButtonProps {
  label: string;
  focused?: boolean;
  disabled?: boolean;
  /** Variant changes color: default = brand, danger = error, ghost = muted. */
  variant?: "default" | "danger" | "ghost";
  /** Optional trailing key hint (e.g. "Enter"). */
  keyHint?: string;
  bg?: string;
}

export const Button = memo(function Button({
  label,
  focused,
  disabled,
  variant = "default",
  keyHint,
  bg,
}: ButtonProps) {
  const t = useTheme();
  const fill = bg ?? (focused ? t.bgPopupHighlight : t.bgPopup);
  const accent =
    variant === "danger" ? t.error : variant === "ghost" ? t.textMuted : t.brandSecondary;
  const border = focused ? accent : t.border;
  const labelFg = disabled ? t.textDim : focused ? accent : t.textPrimary;
  return (
    <FocusTarget active={!!focused}>
      <box
        flexDirection="row"
        borderStyle="rounded"
        border={true}
        borderColor={border}
        paddingX={1}
        backgroundColor={fill}
        flexShrink={0}
      >
        <text bg={fill} fg={labelFg} attributes={focused ? BOLD : undefined}>
          {label}
        </text>
        {keyHint ? (
          <text bg={fill} fg={t.textMuted}>
            {" "}
            [{keyHint}]
          </text>
        ) : null}
      </box>
    </FocusTarget>
  );
});

// ── Toggle ─────────────────────────────────────────────────────────────────
// Boolean on/off. Slider-style: clear at-a-glance state.
// Use for: feature flags, enable/disable settings.

export interface ToggleProps {
  label: string;
  /** Optional one-line description below the label (muted). */
  description?: string;
  on: boolean;
  focused?: boolean;
  bg?: string;
}

export const Toggle = memo(function Toggle({ label, description, on, focused, bg }: ToggleProps) {
  const t = useTheme();
  const fill = bg ?? (focused ? t.bgPopupHighlight : t.bgPopup);
  const trackOn = t.success;
  const trackOff = t.textDim;
  const thumbFg = on ? trackOn : trackOff;
  const labelFg = focused ? t.brand : t.textPrimary;
  const indicator = focused ? "▸ " : "  ";
  return (
    <FocusTarget active={!!focused}>
      <box flexDirection="column" backgroundColor={fill}>
        <box flexDirection="row" backgroundColor={fill}>
          <text bg={fill} fg={focused ? t.brand : t.textFaint}>
            {indicator}
          </text>
          <text bg={fill} fg={labelFg} attributes={focused ? BOLD : undefined}>
            {label}
          </text>
          <text bg={fill}> </text>
          <text bg={fill} fg={thumbFg}>
            {on ? "[●━]" : "[━●]"}
          </text>
          <text bg={fill} fg={on ? t.success : t.textDim}>
            {" "}
            {on ? "ON " : "OFF"}
          </text>
        </box>
        {description ? (
          <text bg={fill} fg={t.textMuted}>
            {"    "}
            {description}
          </text>
        ) : null}
      </box>
    </FocusTarget>
  );
});

// ── Checkbox ───────────────────────────────────────────────────────────────
// Multi-select. Use inside lists where multiple items can be toggled.

export interface CheckboxProps {
  label: string;
  description?: string;
  checked: boolean;
  focused?: boolean;
  bg?: string;
}

export const Checkbox = memo(function Checkbox({
  label,
  description,
  checked,
  focused,
  bg,
}: CheckboxProps) {
  const t = useTheme();
  const fill = bg ?? (focused ? t.bgPopupHighlight : t.bgPopup);
  const boxFg = checked ? t.brandSecondary : t.textDim;
  const labelFg = focused ? t.brand : t.textPrimary;
  const indicator = focused ? "▸ " : "  ";
  return (
    <FocusTarget active={!!focused}>
      <box flexDirection="column" backgroundColor={fill}>
        <box flexDirection="row" backgroundColor={fill}>
          <text bg={fill} fg={focused ? t.brand : t.textFaint}>
            {indicator}
          </text>
          <text bg={fill} fg={boxFg} attributes={BOLD}>
            {checked ? "[✓]" : "[ ]"}
          </text>
          <text bg={fill} fg={labelFg} attributes={focused ? BOLD : undefined}>
            {" "}
            {label}
          </text>
        </box>
        {description ? (
          <text bg={fill} fg={t.textMuted}>
            {"      "}
            {description}
          </text>
        ) : null}
      </box>
    </FocusTarget>
  );
});

// ── Radio ──────────────────────────────────────────────────────────────────
// Single-select within a group. Use for exclusive choices.

export interface RadioProps {
  label: string;
  description?: string;
  selected: boolean;
  focused?: boolean;
  bg?: string;
}

export const Radio = memo(function Radio({
  label,
  description,
  selected,
  focused,
  bg,
}: RadioProps) {
  const t = useTheme();
  const fill = bg ?? (focused ? t.bgPopupHighlight : t.bgPopup);
  const dotFg = selected ? t.brandSecondary : t.textDim;
  const labelFg = focused ? t.brand : selected ? t.textPrimary : t.textSecondary;
  const indicator = focused ? "▸ " : "  ";
  return (
    <FocusTarget active={!!focused}>
      <box flexDirection="column" backgroundColor={fill}>
        <box flexDirection="row" backgroundColor={fill}>
          <text bg={fill} fg={focused ? t.brand : t.textFaint}>
            {indicator}
          </text>
          <text bg={fill} fg={dotFg} attributes={BOLD}>
            {selected ? "(●)" : "( )"}
          </text>
          <text bg={fill} fg={labelFg} attributes={focused || selected ? BOLD : undefined}>
            {" "}
            {label}
          </text>
        </box>
        {description ? (
          <text bg={fill} fg={t.textMuted}>
            {"      "}
            {description}
          </text>
        ) : null}
      </box>
    </FocusTarget>
  );
});

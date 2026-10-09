import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, type ReactNode, useCallback, useRef, useState } from "react";
import { icon as iconFn } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import type { ThemeTokens } from "../../core/theme/tokens.js";
import { Overlay } from "../layout/shared.js";
import { PopupScroll } from "./FocusTarget.js";
import { KeyCaps } from "./KeyCap.js";
import { Flash, type FlashProps } from "./layout.js";
import { PopupViewport } from "./PopupViewport.js";
import {
  fitPopupHeight,
  fitPopupWidth,
  popupSidebarWidth,
  wrapKeyHints,
} from "./popup-geometry.js";
import { useScrollLayout } from "./useScrollLayout.js";

export interface SidebarTab<Id extends string = string> {
  id: Id;
  label: string;
  icon?: string;
  blurb?: string;
  status?: "online" | "offline" | "warning" | "error" | "idle";
  disabled?: boolean;
}

const TAB_STATUS_FG: Record<NonNullable<SidebarTab["status"]>, keyof ThemeTokens> = {
  online: "success",
  offline: "textMuted",
  warning: "warning",
  error: "error",
  idle: "textDim",
};

interface SidebarProps<Id extends string> {
  title: string;
  titleIcon?: string;
  tabs: SidebarTab<Id>[];
  active: Id;
  footer?: ReactNode;
  width: number;
  compact?: boolean;
  onChange?: (id: Id) => void;
}

function SidebarImpl<Id extends string>({
  title,
  tabs,
  active,
  footer,
  width,
  compact,
  onChange,
}: SidebarProps<Id>) {
  const t = useTheme();
  const scroll = useRef<ScrollBoxRenderable>(null);
  const revealActive = useCallback(() => {
    scroll.current?.scrollChildIntoView(`popup-tab-${active}`);
  }, [active]);
  useScrollLayout(scroll, revealActive);
  return (
    <box
      flexDirection="column"
      width={compact ? "100%" : width}
      height={compact ? 2 : "100%"}
      flexShrink={0}
      backgroundColor={t.bgElevated}
      paddingX={1}
      paddingY={compact ? 0 : 1}
    >
      {!compact && (
        <text fg={t.brand} attributes={1} wrapMode="none" truncate>
          {title}
        </text>
      )}
      <scrollbox
        ref={scroll}
        flexGrow={1}
        minHeight={0}
        scrollX={!!compact}
        scrollY={!compact}
        contentOptions={{ flexDirection: compact ? "row" : "column", gap: compact ? 1 : 0 }}
        scrollbarOptions={{ visible: false }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          const bg = selected ? t.bgPopupHighlight : t.bgElevated;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes provide terminal mouse targets; keyboard navigation is owned by the parent.
            <box
              key={tab.id}
              id={`popup-tab-${tab.id}`}
              flexDirection="row"
              height={compact ? 1 : 2}
              flexShrink={0}
              paddingX={1}
              backgroundColor={bg}
              onMouseDown={(event) => {
                if (event.button !== 0 || tab.disabled || !onChange) return;
                event.stopPropagation();
                onChange(tab.id);
              }}
            >
              <text fg={selected ? t.brand : t.textMuted} bg={bg}>
                {selected ? "▸ " : "  "}
              </text>
              <text
                fg={tab.disabled ? t.textDim : selected ? t.brand : t.textSecondary}
                bg={bg}
                attributes={selected ? 1 : undefined}
                wrapMode="none"
                truncate
              >
                {tab.label}
              </text>
              {tab.status && !compact && (
                <text fg={t[TAB_STATUS_FG[tab.status]]} bg={bg}>
                  {" "}
                  ●
                </text>
              )}
            </box>
          );
        })}
      </scrollbox>
      {!compact && footer}
    </box>
  );
}

export const Sidebar = memo(SidebarImpl) as typeof SidebarImpl;

export interface PremiumPopupProps<Id extends string> {
  visible: boolean;
  width: number;
  height: number;
  title: string;
  titleIcon?: string;
  blurb?: string;
  status?: SidebarTab["status"];
  tabs?: SidebarTab<Id>[];
  activeTab?: Id;
  onTabChange?: (id: Id) => void;
  sidebarFooter?: ReactNode;
  sidebarWidth?: number;
  children: ReactNode;
  footerHints?: { key: string; label: string }[];
  flash?: { kind: FlashProps["kind"]; message: string } | null;
  borderColor?: string;
}

function PremiumPopupImpl<Id extends string>({
  visible,
  width,
  height,
  title,
  titleIcon,
  blurb,
  status,
  tabs,
  activeTab,
  onTabChange,
  sidebarFooter,
  sidebarWidth = 22,
  children,
  footerHints = [],
  flash,
  borderColor,
}: PremiumPopupProps<Id>) {
  const t = useTheme();
  const terminal = useTerminalDimensions();
  const body = useRef<ScrollBoxRenderable>(null);
  const w = fitPopupWidth(width, terminal.width);
  const h = fitPopupHeight(height, terminal.height);
  const sideWidth = popupSidebarWidth(w, sidebarWidth);
  const active = tabs?.find((tab) => tab.id === activeTab);
  const subtitle = active?.blurb ?? blurb;
  const state = active?.status ?? status;
  const [overflowed, setOverflowed] = useState(false);
  const hints = wrapKeyHints(
    overflowed ? [...footerHints, { key: "⇧Pg↑↓", label: "scroll" }] : footerHints,
    Math.max(1, w - 6),
  );
  const detectOverflow = useCallback(() => {
    const scroll = body.current;
    if (scroll && scroll.content.height > scroll.viewport.height) setOverflowed(true);
  }, []);
  useScrollLayout(body, detectOverflow, `${visible}:${activeTab ?? title}`);

  useKeyboard((event) => {
    if (!visible || !event.shift || (event.name !== "pageup" && event.name !== "pagedown")) return;
    body.current?.scrollBy(event.name === "pageup" ? -1 : 1, "viewport");
    event.preventDefault();
  });
  if (!visible) return null;

  const navigation =
    tabs && activeTab ? (
      <Sidebar
        title={title}
        titleIcon={titleIcon}
        tabs={tabs}
        active={activeTab}
        footer={sidebarFooter}
        width={sideWidth}
        compact={!sideWidth}
        onChange={onTabChange}
      />
    ) : null;
  return (
    <Overlay>
      <box
        id="baked-popup"
        flexDirection="column"
        borderStyle="rounded"
        border
        borderColor={borderColor ?? t.borderActive}
        width={w}
        height={h}
        backgroundColor={t.bgPopup}
        overflow="hidden"
      >
        <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
          {sideWidth > 0 && navigation}
          <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
            <box
              flexDirection="column"
              height={subtitle ? 3 : 2}
              flexShrink={0}
              paddingX={2}
              backgroundColor={t.bgElevated}
            >
              <box flexDirection="row" height={1}>
                <text fg={t.brand} attributes={1} flexShrink={0}>
                  {titleIcon ? `${iconFn(titleIcon)}  ` : ""}
                </text>
                <text fg={t.textPrimary} attributes={1} flexGrow={1} wrapMode="none" truncate>
                  {active ? `${title} / ${active.label}` : title}
                </text>
                <text fg={state ? t[TAB_STATUS_FG[state]] : t.brand} flexShrink={0}>
                  {state ? ` ● ${state}` : " BAKED"}
                </text>
              </box>
              {subtitle && (
                <text fg={t.textMuted} wrapMode="none" truncate>
                  {subtitle}
                </text>
              )}
            </box>
            {!sideWidth && navigation}
            <scrollbox
              ref={body}
              key={activeTab ?? title}
              id="baked-popup-body"
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              scrollX={false}
              scrollbarOptions={{ showArrows: false }}
            >
              <PopupViewport
                value={{
                  width: w - 2 - (sideWidth && navigation ? sideWidth : 0),
                  height:
                    h -
                    2 -
                    (subtitle ? 3 : 2) -
                    (navigation && !sideWidth ? 2 : 0) -
                    (hints.length ? hints.length + 1 : 0) -
                    (flash ? 1 : 0),
                }}
              >
                <PopupScroll value={body}>
                  <box flexDirection="column" flexShrink={0}>
                    {children}
                  </box>
                </PopupScroll>
              </PopupViewport>
            </scrollbox>
          </box>
        </box>
        {flash && <Flash kind={flash.kind} message={flash.message} />}
        {hints.length > 0 && (
          <box
            flexDirection="column"
            flexShrink={0}
            paddingX={2}
            paddingTop={1}
            backgroundColor={t.bgElevated}
          >
            {hints.map((line) => (
              <KeyCaps
                key={line.map((hint) => hint.key).join("|")}
                hints={line}
                bg={t.bgElevated}
              />
            ))}
          </box>
        )}
      </box>
    </Overlay>
  );
}

export const PremiumPopup = memo(PremiumPopupImpl) as typeof PremiumPopupImpl;

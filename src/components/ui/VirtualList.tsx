import type { ReactNode } from "react";
import { useTheme } from "../../core/theme/index.js";
import { useListViewport } from "./PopupViewport.js";
import { listScrollAccel } from "./scroll.js";
import { useListScroll } from "./useListScroll.js";

const DIM = 2;

export interface VirtualListProps<Item> {
  /** Item array. */
  items: Item[];
  /** Currently-selected index. Caller owns this state. -1 = none. */
  selectedIndex: number;
  /** Render function for each row. */
  renderItem: (
    item: Item,
    state: { index: number; selected: boolean; focused: boolean },
  ) => ReactNode;
  /** Stable key for each row. Falls back to index. */
  keyExtractor?: (item: Item, index: number) => string;
  /** Total outer width in cells. */
  width: number;
  /** Number of rows visible in the viewport. */
  maxRows: number;
  /** Focus state — dims empty-state + counter when unfocused. */
  focused?: boolean;
  /** Message when items is empty. */
  emptyMessage?: string;
  /** Row height (default 1). */
  rowHeight?: number;
  /** Render a trailing "N / total" counter when overflow. Default true. */
  showCounter?: boolean;
  bg?: string;
}

/**
 * VirtualList — scroll-aware renderer owning the `<scrollbox>` viewport.
 *
 * The primitive owns:
 *  - the scrollbox ref + internal offset
 *  - the scroll-into-view effect (selection escapes viewport → scroll)
 *  - empty-state + overflow counter
 *
 * The caller owns:
 *  - the `selectedIndex` state
 *  - all keyboard handling (up/down/enter/etc)
 *  - the row JSX via `renderItem`
 *
 * Use when `Table` (columnar) and `GroupedList` (tree) don't fit — e.g.
 * custom row shapes, cards, mixed toggles/chips, tool lists.
 */
export function VirtualList<Item>({
  items,
  selectedIndex,
  renderItem,
  keyExtractor,
  width: requestedWidth,
  maxRows,
  focused = true,
  emptyMessage = "No results",
  rowHeight = 1,
  showCounter = true,
  bg,
}: VirtualListProps<Item>) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const { ref: scrollRef } = useListScroll(selectedIndex, rowHeight);

  const viewport = useListViewport(requestedWidth, maxRows ?? items.length, rowHeight);
  const width = viewport.width;
  const viewportRows = Math.min(viewport.rows, items.length);
  const viewportHeight = Math.max(1, viewportRows) * rowHeight;

  // Scroll-into-view: only shift viewport when selection escapes it.

  if (items.length === 0) {
    return (
      <box
        flexDirection="row"
        paddingX={2}
        paddingY={1}
        backgroundColor={fill}
        width={width}
        maxWidth="100%"
      >
        <text bg={fill} fg={t.textFaint} attributes={DIM}>
          · {emptyMessage}
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" backgroundColor={fill} width={width} maxWidth="100%">
      <scrollbox
        ref={scrollRef}
        height={viewportHeight}
        scrollX={false}
        scrollAcceleration={listScrollAccel}
      >
        {items.map((item, idx) => {
          const key = keyExtractor ? keyExtractor(item, idx) : `vl-${idx}`;
          const node = renderItem(item, {
            index: idx,
            selected: idx === selectedIndex,
            focused,
          });
          return (
            <box key={key} flexDirection="column" flexShrink={0}>
              {node}
            </box>
          );
        })}
      </scrollbox>

      {showCounter && items.length > viewportRows && selectedIndex >= 0 ? (
        <box flexDirection="row" paddingX={2} height={1} flexShrink={0} backgroundColor={fill}>
          <text bg={fill} fg={t.textFaint}>
            {selectedIndex + 1} / {items.length}
          </text>
        </box>
      ) : null}
    </box>
  );
}

export function fitPopupWidth(preferred: number, columns: number): number {
  return Math.max(1, Math.min(preferred, columns - (columns >= 60 ? 4 : 0)));
}

export function fitPopupHeight(preferred: number, rows: number): number {
  return Math.max(1, Math.min(preferred, rows - (rows >= 20 ? 2 : 0)));
}

export function popupSidebarWidth(width: number, preferred = 22): number {
  return width >= 88 ? preferred : 0;
}

export function popupContentWidth(width: number, sidebar = 22): number {
  const side = popupSidebarWidth(width, sidebar);
  return Math.max(1, width - 2 - (side ? side + 1 : 0));
}

export interface KeyHint {
  key: string;
  label: string;
}

export function wrapKeyHints(hints: KeyHint[], width: number): KeyHint[][] {
  const lines: KeyHint[][] = [];
  let line: KeyHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const size = Bun.stringWidth(hint.key) + Bun.stringWidth(hint.label) + 3;
    if (line.length > 0 && used + size + 3 > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += size + (line.length ? 3 : 0);
    line.push(hint);
  }
  if (line.length) lines.push(line);
  return lines;
}

/** The parts of a textarea that auto-sizing reads and writes. */
export interface AutoSizedField {
  value: string;
  placeholder: string;
  readonly scrollHeight: number;
  style: { height: string };
}

/**
 * Fits a textarea's height to its content, capped at `max` pixels. An empty field is sized to its
 * placeholder, so a long hint that wraps is never cut mid-line (#2680): it measures with the
 * placeholder as its value, then puts the empty value back.
 */
export function autoSizeTextarea(el: AutoSizedField, max: number): void {
  el.style.height = "auto";
  const empty = el.value === "" && el.placeholder !== "";
  if (empty) el.value = el.placeholder;
  const height = el.scrollHeight;
  if (empty) el.value = "";
  el.style.height = `${Math.min(height, max)}px`;
}

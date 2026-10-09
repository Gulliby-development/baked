const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30;

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / MS_PER_MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < MINUTES_PER_HOUR) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${String(hours)}h ago`;
  const days = Math.floor(hours / HOURS_PER_DAY);
  if (days < DAYS_PER_MONTH) return `${String(days)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function truncLine(str: string, max: number): string {
  const line = str.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

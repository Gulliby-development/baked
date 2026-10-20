function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function sumColumn(csv: string, column: string): number {
  const lines = csv.split(/\r?\n/);
  const header = fields(lines[0] ?? "");
  const index = header.indexOf(column);
  if (index < 0) throw new Error(`unknown column: ${column}`);
  let sum = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const cell = (fields(lines[i] as string)[index] ?? "").trim();
    if (cell === "") continue;
    const n = Number(cell);
    if (Number.isNaN(n)) throw new Error(`line ${i + 1}: not a number: ${cell}`);
    sum += n;
  }
  return sum;
}

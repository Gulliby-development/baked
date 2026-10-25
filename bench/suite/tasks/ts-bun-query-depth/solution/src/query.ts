type Segment = { kind: "name"; name: string } | { kind: "index"; index: number };

const MAX_SEGMENTS = 10;

function parse(query: string): Segment[] {
  const fail = (offset: number): never => {
    throw new Error(`invalid query at offset ${offset}`);
  };
  if (query[0] !== "$") fail(0);
  const segments: Segment[] = [];
  let at = 1;
  while (at < query.length) {
    const ch = query[at];
    if (ch === ".") {
      const start = at + 1;
      if (!/[A-Za-z_]/.test(query[start] ?? "")) fail(start);
      let end = start;
      while (end < query.length && /[A-Za-z0-9_]/.test(query[end] ?? "")) end++;
      segments.push({ kind: "name", name: query.slice(start, end) });
      at = end;
    } else if (ch === "[") {
      const start = at + 1;
      let end = start;
      while (end < query.length && /[0-9]/.test(query[end] ?? "")) end++;
      if (end === start) fail(start);
      if (query[start] === "0" && end - start > 1) fail(start + 1);
      if (query[end] !== "]") fail(end);
      segments.push({ kind: "index", index: Number(query.slice(start, end)) });
      at = end + 1;
    } else fail(at);
  }
  return segments;
}

export function evaluate(query: string, value: unknown): unknown {
  const segments = parse(query);
  if (segments.length > MAX_SEGMENTS)
    throw new Error(`depth limit exceeded at segment ${MAX_SEGMENTS + 1}`);
  let current: unknown = value;
  for (const segment of segments) {
    if (segment.kind === "name") {
      if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
      if (!Object.hasOwn(current, segment.name)) return undefined;
      current = (current as Record<string, unknown>)[segment.name];
    } else {
      if (!Array.isArray(current) || segment.index >= current.length) return undefined;
      current = current[segment.index];
    }
  }
  return current;
}

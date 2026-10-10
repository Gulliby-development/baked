import type { AttentionItem, StreamEvent } from "../shared/api.js";

type RawItem = Omit<AttentionItem, "projectKey" | "projectName">;

export function attentionId(
  item: Pick<AttentionItem, "projectKey" | "runId" | "requestId" | "kind">,
): string {
  return `${item.projectKey}:${item.runId}:${item.requestId ?? item.kind}`;
}

/**
 * Merges the attention lists of every open project into one "Needs you" list, newest first, and
 * reports which items appeared since the previous list of the same project.
 */
export class AttentionHub {
  private readonly lists = new Map<string, AttentionItem[]>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly onChange: (items: AttentionItem[], added: AttentionItem[]) => void,
  ) {}

  items(): AttentionItem[] {
    return [...this.lists.values()].flat().sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Handles one event of a project's `/v1/attention` stream. */
  event(projectKey: string, projectName: string, event: StreamEvent): void {
    if (event.event !== "attention") return;
    let raw: RawItem[];
    try {
      raw = (JSON.parse(event.data) as { items?: RawItem[] }).items ?? [];
    } catch {
      return;
    }
    this.set(
      projectKey,
      raw.map((item) => ({ ...item, projectKey, projectName })),
    );
  }

  set(projectKey: string, items: AttentionItem[]): void {
    const first = !this.lists.has(projectKey);
    this.lists.set(projectKey, items);
    const added: AttentionItem[] = [];
    for (const item of items) {
      const id = attentionId(item);
      // The first list of a project is what was already waiting, not news.
      if (!this.seen.has(id) && !first) added.push(item);
      this.seen.add(id);
    }
    this.onChange(this.items(), added);
  }

  remove(projectKey: string): void {
    if (!this.lists.delete(projectKey)) return;
    for (const id of [...this.seen]) if (id.startsWith(`${projectKey}:`)) this.seen.delete(id);
    this.onChange(this.items(), []);
  }
}

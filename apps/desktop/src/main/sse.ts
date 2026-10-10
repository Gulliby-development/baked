import type { StreamEvent } from "../shared/api.js";

/**
 * Incremental Server-Sent Events parser. Feed it decoded text chunks in order; it returns the
 * events completed by each chunk. Comment lines (the server's heartbeats) are skipped.
 */
export class SseParser {
  private buffer = "";
  private id: string | null = null;
  private event = "";
  private data: string[] = [];

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    let newline = this.buffer.search(/\r\n|\r|\n/);
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith("\r\n", newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + width);
      const event = this.line(line);
      if (event) events.push(event);
      newline = this.buffer.search(/\r\n|\r|\n/);
    }
    return events;
  }

  private line(line: string): StreamEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const event = { id: this.id, event: this.event || "message", data: this.data.join("\n") };
      this.event = "";
      this.data = [];
      return event;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}

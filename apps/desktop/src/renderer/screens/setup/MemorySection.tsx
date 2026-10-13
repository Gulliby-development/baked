import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { ChatMemorySection } from "./ChatMemorySection.js";
import { RunMemorySection } from "./RunMemorySection.js";
import { SETUP } from "./shared.js";

/** The parts of the Memory screen; the route's item names the open one. */
export const MEMORY_PARTS = ["chat", "runs"] as const;
export type MemoryPart = (typeof MEMORY_PARTS)[number];

export function memoryPart(id: string | null): MemoryPart {
  return id === "runs" ? "runs" : "chat";
}

/** One screen for what the project remembers: the chat agent's memory and what runs learned. */
export function MemorySection({ project, id }: SectionProps) {
  const part = memoryPart(id);
  return (
    <div className={SETUP}>
      <Tabs
        value={part}
        onValueChange={(value) => {
          window.location.hash = projectHref(project.key, "memory", value as MemoryPart);
        }}
      >
        <TabsList aria-label="Memory">
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
      </Tabs>
      {part === "runs" ? (
        <RunMemorySection project={project} id={null} />
      ) : (
        <ChatMemorySection project={project} id={null} />
      )}
    </div>
  );
}

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Segment } from "../src/renderer/components/ui/segmented.tsx";
import { Tabs, TabsList, TabsTrigger } from "../src/renderer/components/ui/tabs.tsx";

// The app runs Tailwind without preflight, so a kit button without a background class shows the
// platform's grey button face (#2674).
function buttonClasses(html: string): string[] {
  return [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("ui kit buttons", () => {
  test("an inactive tab sets its own background", () => {
    const html = renderToStaticMarkup(
      createElement(
        Tabs,
        { defaultValue: "files" },
        createElement(
          TabsList,
          null,
          createElement(TabsTrigger, { value: "files" }, "Files"),
          createElement(TabsTrigger, { value: "preview" }, "Preview"),
        ),
      ),
    );
    const classes = buttonClasses(html);
    expect(classes).toHaveLength(2);
    for (const cls of classes) expect(cls.split(" ")).toContain("bg-transparent");
  });

  test("a segment sets its own background", () => {
    const [cls] = buttonClasses(renderToStaticMarkup(createElement(Segment, null, "One")));
    expect(cls?.split(" ").some((name) => name.startsWith("bg-"))).toBe(true);
  });
});

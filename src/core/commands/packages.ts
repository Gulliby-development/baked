import { loadConfig } from "../../config/index.js";
import { PackageError } from "../packages/manifest.js";
import {
  describeInstall,
  describeInstalled,
  describePlan,
  describeRemoval,
  type InspectOptions,
  inspectPackage,
  installPackage,
  listPackages,
  removePackage,
} from "../packages/packages.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { PolicySchema } from "../workflows/schemas.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/**
 * `/packages`: BAKED packages of this project (docs/packages.md). `add PATH` shows the plan of a
 * local package and installs it only after the person picks Install; `remove NAME` asks the same
 * way. The work is done by src/core/packages, as `baked add` and `baked packages` do it.
 */

const usage = "Usage: /packages [list] | /packages add PATH | /packages remove NAME";

const options = (): InspectOptions => ({
  policy: PolicySchema.parse(loadConfig().workflows?.policy ?? defaultWorkflowPolicy),
});

function add(ctx: CommandContext, path: string, settings: InspectOptions): void {
  const plan = inspectPackage(path, ctx.cwd, settings);
  sysMsg(ctx, describePlan(plan).join("\n"));
  if (plan.problems.length) return;
  const install = (overwrite: boolean): void => {
    try {
      sysMsg(
        ctx,
        describeInstall(installPackage(plan, { approved: true, overwrite, ...settings })).join(
          "\n",
        ),
      );
    } catch (error) {
      if (error instanceof PackageError) sysMsg(ctx, error.message);
      else throw error;
    }
  };
  ctx.openCommandPicker({
    title: `Install ${plan.name} ${plan.version} into baked/?`,
    icon: "⚠",
    options: [
      plan.overwrites > 0
        ? {
            value: "overwrite",
            label: `Install and replace ${plan.overwrites} project ${plan.overwrites === 1 ? "file" : "files"}`,
            icon: "✓",
          }
        : { value: "install", label: "Install", icon: "✓" },
      { value: "cancel", label: "Cancel", icon: "✕" },
    ],
    onSelect: (value) => {
      if (value === "install" || value === "overwrite") install(value === "overwrite");
      else sysMsg(ctx, "Not installed.");
    },
  });
}

function remove(ctx: CommandContext, name: string): void {
  const entry = listPackages(ctx.cwd).find((p) => p.name === name);
  if (!entry) {
    sysMsg(ctx, `No installed package ${name}.`);
    return;
  }
  ctx.openCommandPicker({
    title: `Remove ${entry.name} ${entry.version}?`,
    icon: "⚠",
    options: [
      {
        value: "remove",
        label: `Remove its unchanged files${entry.changed.length ? `, keep ${entry.changed.length} edited` : ""}`,
        icon: "✓",
      },
      { value: "cancel", label: "Cancel", icon: "✕" },
    ],
    onSelect: (value) => {
      if (value !== "remove") return;
      try {
        sysMsg(ctx, describeRemoval(removePackage(ctx.cwd, name)).join("\n"));
      } catch (error) {
        if (error instanceof PackageError) sysMsg(ctx, error.message);
        else throw error;
      }
    },
  });
}

export function handlePackages(
  input: string,
  ctx: CommandContext,
  settings: () => InspectOptions = options,
): void {
  const rest = input.trim().replace(/^\/packages\b\s*/, "");
  const [sub = "", ...words] = rest.split(/\s+/).filter(Boolean);
  const arg = rest.slice(sub.length).trim();
  try {
    if (sub === "" || (sub === "list" && words.length === 0)) {
      const items = listPackages(ctx.cwd);
      sysMsg(
        ctx,
        items.length
          ? ["Installed packages:", ...items.map((p) => `  ${describeInstalled(p)}`)].join("\n")
          : "No packages installed. Install one with /packages add PATH (a folder with baked-package.json).",
      );
      return;
    }
    if (sub === "add" && arg) {
      add(ctx, arg, settings());
      return;
    }
    if (sub === "remove" && words.length === 1 && words[0]) {
      remove(ctx, words[0]);
      return;
    }
    sysMsg(ctx, usage);
  } catch (error) {
    if (error instanceof PackageError) sysMsg(ctx, error.message);
    else throw error;
  }
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/packages", (input, ctx) => handlePackages(input, ctx));
}

import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** Bundles the main process and the preload script as CommonJS for Electron's Node. */
export async function bundleMain(): Promise<void> {
  for (const [entry, out] of [
    ["src/main/index.ts", "out/main"],
    ["src/preload/index.ts", "out/preload"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir: join(root, out),
      target: "node",
      format: "cjs",
      external: ["electron"],
      naming: "[name].cjs",
      sourcemap: "linked",
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Bundling ${entry} failed`);
    }
  }
}

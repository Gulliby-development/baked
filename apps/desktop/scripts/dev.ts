import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { bundleMain } from "./bundle-main.ts";

// Runs the app from source: the renderer from Vite's dev server, backends from the repository.
const root = join(import.meta.dir, "..");
await bundleMain();
// Voice input reads the staged engine (src/main/voice.ts); stage it once, as packaging does. The
// model download is cached, and the app still starts without it.
if (!existsSync(join(root, "dist", ".stage", "voice", "whistle.cact"))) {
  const staged = await Bun.spawn([process.execPath, join(root, "scripts", "stage-voice.ts")], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
  if (staged !== 0) console.warn("dev: voice input stays off until `bun run stage:voice` succeeds");
}
const server = await createServer({ configFile: join(root, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("Vite did not report a URL");
const electron = Bun.spawn([join(root, "node_modules", ".bin", "electron"), root], {
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
  stdio: ["inherit", "inherit", "inherit"],
});
await electron.exited;
await server.close();

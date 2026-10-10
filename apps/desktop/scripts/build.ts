import { join } from "node:path";
import { build } from "vite";
import { bundleMain } from "./bundle-main.ts";

await build({ configFile: join(import.meta.dir, "..", "vite.config.ts") });
await bundleMain();

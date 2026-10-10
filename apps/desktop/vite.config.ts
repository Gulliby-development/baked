import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  // Relative asset paths: the packaged app loads index.html from disk.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../out/renderer",
    emptyOutDir: true,
    target: "chrome130",
  },
  server: { port: 5199, strictPort: true },
});

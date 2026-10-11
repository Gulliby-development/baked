import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  // Relative asset paths: the packaged app loads index.html from disk.
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../out/renderer",
    emptyOutDir: true,
    target: "chrome130",
  },
  // The Code graph preview runs the core grouping (src/core/intelligence) in the browser.
  server: { port: 5199, strictPort: true, fs: { allow: ["../.."] } },
});

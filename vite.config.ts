import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The renderer is the React/Vite layer of the Codex-style desktop shell:
// React UI → preload bridge → Electron main process (SQLite, Git, PTY-less
// child CLIs, MCP). Vite only builds the renderer; the main process is
// compiled separately by tsconfig.node.json.
export default defineConfig({
  // Packaged GUI loads dist/ via file:// (loadFile); absolute "/assets/…"
  // paths break there, so keep asset URLs relative to index.html.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});

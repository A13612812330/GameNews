import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [path.resolve("."), path.resolve("../NewgameWiki")] },
    proxy: { "/api": "http://127.0.0.1:64500" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

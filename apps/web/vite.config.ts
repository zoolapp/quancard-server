import { readFileSync } from "node:fs";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;

export default defineConfig({
  plugins: [preact()],
  define: { __APP_VERSION__: JSON.stringify(process.env.QC_VERSION ?? version) },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    // Deterministic file names so release builds can be hashed and compared.
    rollupOptions: {
      output: { entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } },
  },
});

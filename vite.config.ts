import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { host: true, port: 5173 },
  build: { target: "es2022", sourcemap: true },
  // rapier3d-compat inlines its wasm as base64, so no special wasm plugin is needed.
  optimizeDeps: { exclude: [] },
});

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "server-only": path.resolve(__dirname, "src/test/empty.ts"), "@": path.resolve(__dirname, "src") } },
  test: { environment: "node" },
});

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // db.ts imports "server-only", which throws outside Next's RSC bundler.
      "server-only": new URL("./test/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // DB tests share one Postgres; run files serially to avoid cross-test races.
    fileParallelism: false,
  },
});

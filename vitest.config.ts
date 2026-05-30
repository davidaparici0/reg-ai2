import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// db.ts imports "server-only", which throws when evaluated outside Next's RSC
// bundler. Alias it to an empty stub for tests. Path is resolved from cwd (the
// project root when running vitest) — NOT import.meta.url, since vitest bundles
// this config to a temp file, which would make import.meta.url-relative paths wrong.
const serverOnlyStub = resolve(process.cwd(), "test/stubs/server-only.ts");

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // DB tests share one Postgres; run files serially to avoid cross-test races.
    fileParallelism: false,
    alias: {
      "server-only": serverOnlyStub,
    },
  },
});

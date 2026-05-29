// drizzle-kit config — drives migration generation + apply.
//
// drizzle-kit runs OUTSIDE Next.js (it's a standalone CLI), so it doesn't get
// Next's automatic .env loading. `dotenv/config` loads .env here so the CLI can
// read DATABASE_URL the same way the app does.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts", // single source of truth (Phase D); lives at repo root
  out: "./drizzle", // generated SQL migrations + journal land here
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

// drizzle-kit config — drives migration generation + apply.
//
// drizzle-kit runs OUTSIDE Next.js (it's a standalone CLI), so it doesn't get
// Next's automatic .env loading. `dotenv/config` loads .env here.
//
// Migrations run DDL (create tables, policies, ROLES) — that needs the admin role
// `reg`, not the app's non-superuser `reg_app`. So drizzle-kit uses
// MIGRATION_DATABASE_URL (reg); the app pool uses DATABASE_URL (reg_app). Fallback
// to DATABASE_URL keeps single-URL setups working.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts", // single source of truth (Phase D); lives at repo root
  out: "./drizzle", // generated SQL migrations + journal land here
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL!,
  },
});

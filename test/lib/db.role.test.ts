import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Guards the single most important invariant in the system. Every tenant-isolation test is
// meaningful ONLY because the app connects as a role that RLS actually binds (reg_app:
// NOSUPERUSER, NOBYPASSRLS). If DATABASE_URL ever regressed to the `reg` SUPERUSER, RLS would
// be bypassed and every isolation test would pass-by-bypass — silently proving nothing. This
// test fails loudly if that happens.
describe("app DB role", () => {
  it("is NON-superuser and NON-bypassRLS (so RLS is genuinely enforced)", async () => {
    const { rows } = await db.execute(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
});

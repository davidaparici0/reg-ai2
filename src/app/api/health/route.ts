// GET /api/health — Phase 0 liveness gate (FR-024).
//
// Proves two things the prototype never did: the server can reach Postgres, AND
// pgvector is actually installed (no vector extension => the whole RAG layer is
// dead, so we surface that explicitly rather than 200-ing on a half-broken DB).
//
// Consumed by Docker/Fly healthchecks later. force-dynamic so it's never cached —
// a health check must reflect live state on every request.
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Single round-trip doubles as the liveness probe (the query itself proves
    // the connection works) and the pgvector presence check.
    const result = await db.execute(
      sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    const vector = (result.rows[0]?.extversion as string | undefined) ?? null;

    if (!vector) {
      return NextResponse.json(
        { db: "ok", vector: null, error: "pgvector not installed" },
        { status: 503 },
      );
    }

    return NextResponse.json({ db: "ok", vector });
  } catch (err) {
    // Log server-side only; never return internals (could leak the DSN).
    console.error("[/api/health] DB check failed:", err);
    return NextResponse.json({ db: "down" }, { status: 503 });
  }
}

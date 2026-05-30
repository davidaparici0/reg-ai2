// Process-wide Postgres connection pool + Drizzle client.
//
// `import "server-only"` makes the build FAIL if this module is ever imported
// into client code — a hard guard for the "secrets server-side only" constraint.
// DATABASE_URL (and the LLM key later) can never leak into the browser bundle.
import "server-only";

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Fail loud at startup, not with a confusing error deep in a query.
  throw new Error("DATABASE_URL is not set (server-only). Copy .env.example -> .env");
}

// ONE Pool per process — never per request (a new pool per request would
// exhaust Postgres connections). In dev, Next.js re-evaluates modules on every
// hot reload, which would leak a fresh pool each time; caching on globalThis
// reuses the same one. In prod it's just a normal module singleton.
const globalForDb = globalThis as unknown as { _pgPool?: Pool };

export const pool =
  globalForDb._pgPool ?? new Pool({ connectionString, max: 10 });

if (process.env.NODE_ENV !== "production") globalForDb._pgPool = pool;

// The Drizzle client. Passing `schema` gives us typed queries + relations.
// In Phase 1, tenant-scoped requests will check out a connection from this pool
// and run `set_config('app.restaurant_id', …)` on it before querying (RLS).
export const db = drizzle(pool, { schema });

// The drizzle transaction handle type (what withTenant hands its callback).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Run `fn` inside a transaction with app.restaurant_id set for RLS.
// `true` = transaction-local: auto-clears on commit/rollback, so the GUC can NEVER
// leak into the next request that reuses this pooled connection. This is the single
// most important correctness detail of Phase 1.
export function withTenant<T>(restaurantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
    return fn(tx);
  });
}

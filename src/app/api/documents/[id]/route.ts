import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, chunks } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";

const Uuid = z.string().uuid();

// GET /api/documents/:id — owner|manager, this tenant's document only.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const { id } = await ctx.params;
  if (!Uuid.safeParse(id).success) return errorResponse("NOT_FOUND", "Document not found"); // not a real id

  const [doc] = await withTenant(session.restaurant.id, (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      error: documents.error,
      chunkCount: sql<number>`(select count(*)::int from ${chunks} where ${chunks.documentId} = ${documents.id})`,
    }).from(documents).where(eq(documents.id, id)).limit(1));

  if (!doc) return errorResponse("NOT_FOUND", "Document not found"); // RLS hides other tenants -> 404
  return NextResponse.json({
    id: doc.id, title: doc.title, status: doc.status, error: doc.error,
    chunkCount: doc.status === "done" ? doc.chunkCount : null,
  });
}

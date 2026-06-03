import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, documentBlobs, chunks } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PAGE_SIZE = 20;

// POST /api/documents — owner|manager. multipart/form-data: file (PDF), title?.
export async function POST(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  let form: FormData;
  try { form = await req.formData(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected multipart/form-data"); }

  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse("VALIDATION_ERROR", "Missing file");
  if (file.type !== "application/pdf") return errorResponse("VALIDATION_ERROR", "Only PDF is supported");
  if (file.size > MAX_BYTES) return errorResponse("VALIDATION_ERROR", "File exceeds the 10 MB limit");

  const titleRaw = form.get("title");
  const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : file.name;

  const bytes = Buffer.from(await file.arrayBuffer());
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const rid = session.restaurant.id;

  const result = await withTenant(rid, async (tx) => {
    const inserted = await tx.insert(documents).values({
      restaurantId: rid, title, sourceType: "pdf", contentHash, status: "pending", uploadedBy: session.user.id,
    }).onConflictDoNothing({ target: [documents.restaurantId, documents.contentHash] })
      .returning({ id: documents.id });

    if (inserted.length) {
      await tx.insert(documentBlobs).values({ documentId: inserted[0].id, restaurantId: rid, bytes });
      return { id: inserted[0].id, status: "pending" as const, created: true };
    }
    // Duplicate (restaurant_id, content_hash): return the existing doc; retry if it failed.
    const [existing] = await tx.select({ id: documents.id, status: documents.status })
      .from(documents).where(and(eq(documents.restaurantId, rid), eq(documents.contentHash, contentHash))).limit(1);
    if (existing.status === "failed") {
      await tx.update(documents).set({ status: "pending", error: null }).where(eq(documents.id, existing.id));
      return { id: existing.id, status: "pending" as const, created: false };
    }
    return { id: existing.id, status: existing.status, created: false };
  });

  return NextResponse.json({ documentId: result.id, status: result.status }, { status: result.created ? 202 : 200 });
}

// GET /api/documents — owner|manager. Cursor pagination on created_at.
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const rid = session.restaurant.id;

  const cursor = new URL(req.url).searchParams.get("cursor");
  const rows = await withTenant(rid, (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      error: documents.error,
      createdAt: documents.createdAt,
      // Table-qualified: ${chunks.documentId} interpolates UNqualified ("document_id"), which
      // inside `from chunks` binds to chunks.id-vs-document_id and counts 0. Qualify via the
      // table objects so it is "chunks".document_id = "documents".id (the correlated count).
      chunkCount: sql<number>`(select count(*)::int from ${chunks} where ${chunks}.document_id = ${documents}.id)`,
    }).from(documents)
      .where(cursor ? lt(documents.createdAt, new Date(cursor)) : undefined)
      .orderBy(desc(documents.createdAt))
      .limit(PAGE_SIZE + 1));

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  return NextResponse.json({
    items: page.map((d) => ({
      id: d.id, title: d.title, status: d.status, error: d.error,
      chunkCount: d.status === "done" ? d.chunkCount : null,
    })),
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  });
}

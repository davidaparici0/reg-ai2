import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { toPublicUser } from "@/lib/auth/types";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in");
  return NextResponse.json({ user: toPublicUser(session.user), restaurant: session.restaurant });
}

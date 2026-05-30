import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSession, buildSessionCookie } from "@/lib/auth/session";
import { RegisterReq, toPublicUser } from "@/lib/auth/types";
import { errorResponse } from "@/lib/http/errors";

export async function POST(req: Request) {
  const parsed = RegisterReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "Invalid registration", parsed.error.flatten());
  }
  const email = parsed.data.email.trim().toLowerCase();

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length) return errorResponse("CONFLICT", "Email already registered");

  const passwordHash = await hashPassword(parsed.data.password);

  const { user, restaurant } = await db.transaction(async (tx) => {
    const [restaurant] = await tx.insert(restaurants).values({ name: parsed.data.restaurantName }).returning();
    const [user] = await tx.insert(users)
      .values({ restaurantId: restaurant.id, email, passwordHash, role: "owner" }).returning();
    return { user, restaurant };
  });

  const { token, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ user: toPublicUser(user), restaurant }, { status: 201 });
  res.cookies.set(buildSessionCookie(token, expiresAt));
  return res;
}

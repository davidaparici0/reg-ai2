import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions, users, restaurants } from "@/db/schema";
import type { Restaurant, UserRow } from "@/lib/auth/types";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, no sliding renewal
export const SESSION_COOKIE = "sid";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export type ResolvedSession = { user: UserRow; restaurant: Restaurant };

export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const id = hashToken(token);
  const rows = await db
    .select({ session: sessions, user: users, restaurant: restaurants })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(restaurants, eq(restaurants.id, users.restaurantId))
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  return { user: row.user, restaurant: row.restaurant };
}

export async function revokeSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

type CookieSpec = {
  name: string; value: string; httpOnly: true; sameSite: "strict";
  secure: true; path: "/"; expires?: Date; maxAge?: number;
};

export function buildSessionCookie(token: string, expiresAt: Date): CookieSpec {
  return { name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: "strict", secure: true, path: "/", expires: expiresAt };
}

export function clearSessionCookie(): CookieSpec {
  return { name: SESSION_COOKIE, value: "", httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 0 };
}

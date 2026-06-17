import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, restaurants } from "@/db/schema";
import { verifyPassword, verifyDummy } from "@/lib/auth/password";
import { createSession, buildSessionCookie } from "@/lib/auth/session";
import { LoginReq, toPublicUser } from "@/lib/auth/types";
import { errorResponse } from "@/lib/http/errors";
import { clientIp, enforceLimit } from "@/lib/ratelimit/guard";
import { RL, rlKeys } from "@/lib/ratelimit/config";
import { withRequestLog } from "@/lib/obs/with-request-log";

async function postHandler(req: Request) {
  const ip = clientIp(req);
  if (ip) {
    const limited = await enforceLimit(rlKeys.login(ip), RL.loginPerIp.limit, RL.loginPerIp.windowSeconds);
    if (limited) return limited;
  }
  const parsed = LoginReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "Invalid login", parsed.error.flatten());
  }
  const email = parsed.data.email.trim().toLowerCase();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    await verifyDummy(parsed.data.password); // equalize timing — no user enumeration
    return errorResponse("UNAUTHENTICATED", "Invalid email or password");
  }
  if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
    return errorResponse("UNAUTHENTICATED", "Invalid email or password");
  }

  const [restaurant] = await db.select().from(restaurants).where(eq(restaurants.id, user.restaurantId)).limit(1);
  const { token, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ user: toPublicUser(user), restaurant }, { status: 200 });
  res.cookies.set(buildSessionCookie(token, expiresAt));
  return res;
}

export const POST = withRequestLog("auth/login", postHandler);

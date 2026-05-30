import { NextResponse } from "next/server";
import { readCookie } from "@/lib/auth/guard";
import { revokeSession, clearSessionCookie, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(req: Request) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await revokeSession(token);
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(clearSessionCookie());
  return res;
}

import { POST as register } from "@/app/api/auth/register/route";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { track } from "./db";

// Registers a fresh restaurant + owner; returns a ready-to-use cookie header value.
export async function registerOwner() {
  const email = `${crypto.randomUUID()}@t.test`;
  const res = await register(new Request("http://x/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ restaurantName: "T", email, password: "x".repeat(12) }),
  }));
  const json = await res.json();
  track(json.restaurant.id);
  return { cookie: `sid=${res.cookies.get("sid")!.value}`, restaurant: json.restaurant, user: json.user };
}

// Creates an extra user (any role) in an existing restaurant + a session cookie for it.
export async function makeUserCookie(restaurantId: string, role: "manager" | "trainee") {
  const [u] = await db.insert(users).values({
    restaurantId,
    email: `${crypto.randomUUID()}@t.test`,
    passwordHash: await hashPassword("x".repeat(12)),
    role,
  }).returning();
  const { token } = await createSession(u.id);
  return { cookie: `sid=${token}`, user: u };
}

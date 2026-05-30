import { z } from "zod";
import type { InferSelectModel } from "drizzle-orm";
import type { users, restaurants } from "@/db/schema";

export const RegisterReq = z.object({
  restaurantName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12),
});
export const LoginReq = z.object({
  email: z.string().email(),
  password: z.string(),
});

export type UserRow = InferSelectModel<typeof users>;
export type Restaurant = InferSelectModel<typeof restaurants>;
export type PublicUser = Omit<UserRow, "passwordHash">;

export function toPublicUser(u: UserRow): PublicUser {
  const { passwordHash: _omit, ...pub } = u;
  return pub;
}

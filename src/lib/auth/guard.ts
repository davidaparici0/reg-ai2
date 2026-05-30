import { resolveSession, type ResolvedSession, SESSION_COOKIE } from "@/lib/auth/session";

const ROLE_RANK = { trainee: 1, manager: 2, owner: 3 } as const;
export type Role = keyof typeof ROLE_RANK;

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function requireSession(req: Request): Promise<ResolvedSession | null> {
  const token = readCookie(req, SESSION_COOKIE);
  return token ? resolveSession(token) : Promise.resolve(null);
}

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

import { NextResponse } from "next/server";

export type ErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN"
  | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, INTERNAL: 500,
};

export function errorResponse(code: ErrorCode, message: string, details?: unknown): NextResponse {
  const body = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status: STATUS[code] });
}

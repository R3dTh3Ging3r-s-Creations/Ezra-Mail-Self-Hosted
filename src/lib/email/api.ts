import { NextResponse } from "next/server";
import { AuthError, requireAuth } from "./auth";

export async function authenticated<T>(request: Request, handler: () => Promise<T>) {
  try {
    await requireAuth(request);
    return NextResponse.json(await handler());
  } catch (error) {
    return apiError(error);
  }
}

export function apiError(error: unknown) {
  const status = error instanceof AuthError ? error.status : 400;
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ ok: false, error: message }, { status });
}

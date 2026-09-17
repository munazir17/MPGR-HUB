import { NextResponse } from "next/server";
import { SESSION_COOKIE, getAuthCookieAttributes } from "@/lib/auth/config";
export async function POST() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE, "", { ...getAuthCookieAttributes(), maxAge: 0 });
  return response;
}
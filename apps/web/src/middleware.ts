import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/_next", "/favicon"];
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get("qg_session")) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/((?!api).*)"] };

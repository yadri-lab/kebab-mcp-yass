import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = process.env.MCP_AUTH_TOKEN?.trim();

  // Protect admin dashboard — accepts token in query string (for browser access)
  if (pathname === "/" && token) {
    const queryToken = request.nextUrl.searchParams.get("token")?.trim();
    const authHeader = request.headers.get("authorization");
    const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim();

    if (bearer !== token && queryToken !== token) {
      return new NextResponse(
        "Unauthorized — append ?token=<MCP_AUTH_TOKEN> to access the dashboard",
        { status: 401, headers: { "Content-Type": "text/plain" } }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};

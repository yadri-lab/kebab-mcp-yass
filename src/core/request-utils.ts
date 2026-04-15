/**
 * Shared HTTP request helpers.
 *
 * Currently used by first-run / setup paths to determine whether a request
 * originates from a loopback address — first-run flows trust loopback as a
 * substitute for a real auth token.
 */

import type { NextRequest } from "next/server";

function isLoopbackCandidate(ip: string): boolean {
  const n = ip
    .replace(/^::ffff:/, "")
    .trim()
    .toLowerCase();
  return n === "127.0.0.1" || n === "::1" || n === "localhost" || n.startsWith("127.");
}

/**
 * Returns true if the request safely originates from loopback.
 *
 * Priority:
 * 1. On Vercel, never — hard guard against any misconfiguration granting
 *    first-run admin access in production.
 * 2. If `x-forwarded-for` / `x-real-ip` is set (proxy in front), require
 *    the leftmost IP to be loopback.
 * 3. If `NextRequest.ip` is available (older Next versions), check it.
 * 4. Optional URL-host fallback (NIT-05): only when MYMCP_TRUST_URL_HOST=1.
 *    Off by default — a reverse proxy that forgets x-forwarded-for and
 *    happens to forward Host: localhost would otherwise grant first-run
 *    admin access on a non-Vercel deploy. Operators of `next dev` via
 *    http://localhost:3000 with no proxy in front can opt back in.
 *
 * Previous behavior (v0.5 phase 13) trusted the URL host unconditionally.
 * v0.6 NIT-05 narrowed it to opt-in to shrink the attack surface for
 * Docker/custom deploys behind misconfigured proxies.
 */
export function isLoopbackRequest(request: Request): boolean {
  if (process.env.VERCEL === "1") return false;

  const xff = request.headers.get("x-forwarded-for");
  const xri = request.headers.get("x-real-ip");
  if (xff) {
    const leftmost = xff.split(",")[0]?.trim() || "";
    return isLoopbackCandidate(leftmost);
  }
  if (xri) {
    return isLoopbackCandidate(xri);
  }
  const ip = (request as unknown as NextRequest & { ip?: string }).ip;
  if (ip) return isLoopbackCandidate(ip);

  // Last resort, opt-in only: check the URL hostname. Off by default
  // because a misconfigured reverse proxy can forward Host: localhost
  // from the public internet. Set MYMCP_TRUST_URL_HOST=1 only when you
  // know nothing in front of this server can spoof Host.
  if (process.env.MYMCP_TRUST_URL_HOST === "1") {
    try {
      const urlHost = new URL(request.url).hostname.toLowerCase();
      return isLoopbackCandidate(urlHost);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Best-effort client IP extraction for per-IP rate limiting.
 *
 * Priority: x-forwarded-for leftmost → x-real-ip → NextRequest.ip → "unknown".
 * Only trust x-forwarded-for when running behind Vercel (VERCEL=1) — otherwise
 * a malicious client could spoof it.
 */
export function getClientIP(request: Request): string {
  const isVercel = process.env.VERCEL === "1";
  if (isVercel) {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const leftmost = xff.split(",")[0]?.trim();
      if (leftmost) return leftmost;
    }
    const xri = request.headers.get("x-real-ip");
    if (xri) return xri.trim();
  }
  const ip = (request as unknown as NextRequest & { ip?: string }).ip;
  if (ip) return ip;
  return "unknown";
}

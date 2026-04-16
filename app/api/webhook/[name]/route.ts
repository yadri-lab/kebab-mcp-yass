import { createHmac, timingSafeEqual } from "crypto";
import { getKVStore } from "@/core/kv-store";

/**
 * Webhook receiver endpoint.
 *
 * POST /api/webhook/:name
 *
 * Validates `name` against MYMCP_WEBHOOKS allowlist (comma-separated).
 * Optional HMAC-SHA256 signature verification via MYMCP_WEBHOOK_SECRET_<NAME>.
 * Stores payload in KV at `webhook:last:<name>`.
 */

function getAllowedWebhooks(): Set<string> {
  const raw = process.env.MYMCP_WEBHOOKS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function verifySignature(body: string, name: string, signature: string): boolean {
  const envKey = `MYMCP_WEBHOOK_SECRET_${name.toUpperCase().replace(/-/g, "_")}`;
  const secret = process.env[envKey];
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
): Promise<Response> {
  const { name } = await params;
  const normalizedName = name.trim().toLowerCase();

  // Validate against allowlist
  const allowed = getAllowedWebhooks();
  if (!allowed.has(normalizedName)) {
    return new Response(JSON.stringify({ error: "Webhook not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Read body
  const body = await request.text();

  // Optional HMAC signature verification
  const secretEnvKey = `MYMCP_WEBHOOK_SECRET_${normalizedName.toUpperCase().replace(/-/g, "_")}`;
  if (process.env[secretEnvKey]) {
    const signature = request.headers.get("x-webhook-signature");
    if (!signature || !verifySignature(body, normalizedName, signature)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Parse payload (best-effort JSON, fall back to raw string)
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = body;
  }

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const entry = {
    payload,
    receivedAt: new Date().toISOString(),
    contentType,
  };

  // Store in KV
  const kv = getKVStore();
  await kv.set(`webhook:last:${normalizedName}`, JSON.stringify(entry));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

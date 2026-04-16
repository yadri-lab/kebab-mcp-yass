/**
 * Tests for tenant-aware MCP auth: tenant-specific tokens via
 * MCP_AUTH_TOKEN_<TENANTID>, fall-back to global MCP_AUTH_TOKEN.
 */
import { describe, it, expect, afterEach } from "vitest";
import { checkMcpAuth } from "@/core/auth";

function makeRequest(token?: string, tenantId?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (tenantId) headers["x-mymcp-tenant"] = tenantId;
  return new Request("http://localhost/api/mcp", { headers });
}

describe("checkMcpAuth with tenant header", () => {
  const origToken = process.env.MCP_AUTH_TOKEN;

  afterEach(() => {
    if (origToken === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = origToken;
    // Clean up tenant-specific env vars
    delete process.env.MCP_AUTH_TOKEN_ACME;
    delete process.env.MCP_AUTH_TOKEN_BETA_ORG;
  });

  it("returns tenantId=null when no tenant header", () => {
    process.env.MCP_AUTH_TOKEN = "globaltoken1234567";
    const { tenantId } = checkMcpAuth(makeRequest("globaltoken1234567"));
    expect(tenantId).toBeNull();
  });

  it("returns tenantId from header", () => {
    process.env.MCP_AUTH_TOKEN = "globaltoken1234567";
    const { error, tenantId } = checkMcpAuth(makeRequest("globaltoken1234567", "acme"));
    expect(error).toBeNull();
    expect(tenantId).toBe("acme");
  });

  it("uses tenant-specific token env var", () => {
    process.env.MCP_AUTH_TOKEN = "globaltoken1234567";
    process.env.MCP_AUTH_TOKEN_ACME = "acmetoken1234567890";
    // Global token should NOT work for acme tenant
    const { error: e1 } = checkMcpAuth(makeRequest("globaltoken1234567", "acme"));
    expect(e1).not.toBeNull();
    // Tenant-specific token should work
    const { error: e2, tenantId } = checkMcpAuth(makeRequest("acmetoken1234567890", "acme"));
    expect(e2).toBeNull();
    expect(tenantId).toBe("acme");
  });

  it("falls back to global token when no tenant-specific token", () => {
    process.env.MCP_AUTH_TOKEN = "globaltoken1234567";
    const { error, tenantId } = checkMcpAuth(makeRequest("globaltoken1234567", "beta-org"));
    expect(error).toBeNull();
    expect(tenantId).toBe("beta-org");
  });

  it("returns 400 for invalid tenant ID", () => {
    process.env.MCP_AUTH_TOKEN = "globaltoken1234567";
    const { error } = checkMcpAuth(makeRequest("globaltoken1234567", "bad tenant!"));
    expect(error).not.toBeNull();
    expect(error!.status).toBe(400);
  });

  it("handles hyphenated tenant ID in env var lookup", () => {
    process.env.MCP_AUTH_TOKEN_BETA_ORG = "betatoken12345678901";
    const { error, tenantId } = checkMcpAuth(makeRequest("betatoken12345678901", "beta-org"));
    expect(error).toBeNull();
    expect(tenantId).toBe("beta-org");
  });
});

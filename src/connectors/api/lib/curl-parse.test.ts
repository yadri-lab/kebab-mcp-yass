import { describe, it, expect } from "vitest";
import { tokenizeCurl, parseCurl, curlToDraft } from "./curl-parse";

describe("tokenizeCurl", () => {
  it("splits simple commands", () => {
    expect(tokenizeCurl("curl https://x.example.com")).toEqual(["curl", "https://x.example.com"]);
  });

  it("respects double quotes", () => {
    const t = tokenizeCurl(`curl -H "Content-Type: application/json" https://x`);
    expect(t).toEqual(["curl", "-H", "Content-Type: application/json", "https://x"]);
  });

  it("respects single quotes", () => {
    const t = tokenizeCurl(`curl -H 'X-Api-Key: secret token' https://x`);
    expect(t).toEqual(["curl", "-H", "X-Api-Key: secret token", "https://x"]);
  });

  it("handles backslash line continuations", () => {
    const t = tokenizeCurl(`curl -X POST \\\n  https://x`);
    expect(t).toEqual(["curl", "-X", "POST", "https://x"]);
  });
});

describe("parseCurl", () => {
  it("parses a minimal GET", () => {
    const p = parseCurl("curl https://api.example.com/users");
    expect(p.method).toBe("GET");
    expect(p.url).toBe("https://api.example.com/users");
    expect(p.headers).toEqual({});
  });

  it("extracts method + headers + body", () => {
    const p = parseCurl(
      `curl -X POST https://api.example.com/widgets ` +
        `-H "Content-Type: application/json" ` +
        `-H "Authorization: Bearer abc" ` +
        `--data '{"name":"foo"}'`
    );
    expect(p.method).toBe("POST");
    expect(p.url).toBe("https://api.example.com/widgets");
    expect(p.headers["Content-Type"]).toBe("application/json");
    expect(p.headers.Authorization).toBe("Bearer abc");
    expect(p.body).toBe('{"name":"foo"}');
  });

  it("defaults to POST when a body is present without -X", () => {
    const p = parseCurl(`curl https://api.example.com -d '{"x":1}'`);
    expect(p.method).toBe("POST");
  });

  it("handles -u basic auth", () => {
    const p = parseCurl(`curl -u user:pass https://api.example.com`);
    expect(p.basicAuth).toEqual({ username: "user", password: "pass" });
  });

  it("handles --header=value long form", () => {
    const p = parseCurl(`curl --header="X-Custom: hello" https://api.example.com`);
    expect(p.headers["X-Custom"]).toBe("hello");
  });

  it("throws on empty input", () => {
    expect(() => parseCurl("")).toThrow(/empty/i);
  });

  it("throws when no URL found", () => {
    expect(() => parseCurl("curl -X POST")).toThrow(/no url/i);
  });

  it("silently skips unknown flags", () => {
    const p = parseCurl(`curl --compressed -s https://api.example.com`);
    expect(p.url).toBe("https://api.example.com");
    expect(p.method).toBe("GET");
  });
});

describe("curlToDraft", () => {
  it("splits URL into baseUrl + pathTemplate + queryTemplate", () => {
    const p = parseCurl("curl https://api.example.com/v1/users?limit=10&sort=name");
    const d = curlToDraft(p);
    expect(d.baseUrl).toBe("https://api.example.com");
    expect(d.pathTemplate).toBe("/v1/users");
    expect(d.queryTemplate).toEqual({ limit: "10", sort: "name" });
  });

  it("promotes Bearer Authorization header to suggestedAuth", () => {
    const p = parseCurl(`curl https://api.example.com -H "Authorization: Bearer xyz-token"`);
    const d = curlToDraft(p);
    expect(d.suggestedAuth).toEqual({ type: "bearer", token: "xyz-token" });
    expect(d.headers.Authorization).toBeUndefined();
  });

  it("promotes -u to suggestedAuth type=basic", () => {
    const p = parseCurl(`curl -u alice:secret https://api.example.com`);
    const d = curlToDraft(p);
    expect(d.suggestedAuth).toEqual({
      type: "basic",
      username: "alice",
      password: "secret",
    });
  });

  it("keeps non-auth headers in draft.headers", () => {
    const p = parseCurl(`curl -H "X-Trace: 42" https://api.example.com`);
    const d = curlToDraft(p);
    expect(d.headers["X-Trace"]).toBe("42");
  });
});

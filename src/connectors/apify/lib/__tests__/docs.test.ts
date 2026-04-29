import { describe, it, expect } from "vitest";
import { buildMarkdownUrl, isAllowedDocUrl } from "../docs";

describe("buildMarkdownUrl", () => {
  it("appends .md to a clean docs URL", () => {
    expect(buildMarkdownUrl("https://docs.apify.com/platform/actors/running")).toBe(
      "https://docs.apify.com/platform/actors/running.md"
    );
  });

  it("strips a trailing slash before appending .md", () => {
    expect(buildMarkdownUrl("https://docs.apify.com/platform/actors/running/")).toBe(
      "https://docs.apify.com/platform/actors/running.md"
    );
  });

  it("strips the hash fragment", () => {
    expect(buildMarkdownUrl("https://docs.apify.com/platform/actors/running#builds")).toBe(
      "https://docs.apify.com/platform/actors/running.md"
    );
  });

  it("rewrites a bare host to /index.md (no DNS-only foo.com.md)", () => {
    expect(buildMarkdownUrl("https://docs.apify.com")).toBe("https://docs.apify.com/index.md");
    expect(buildMarkdownUrl("https://docs.apify.com/")).toBe("https://docs.apify.com/index.md");
  });

  it("handles Crawlee URLs the same way", () => {
    expect(buildMarkdownUrl("https://crawlee.dev/docs/guides/basic-concepts")).toBe(
      "https://crawlee.dev/docs/guides/basic-concepts.md"
    );
  });
});

describe("isAllowedDocUrl", () => {
  it("accepts the official docs domains", () => {
    expect(isAllowedDocUrl("https://docs.apify.com/platform")).toBe(true);
    expect(isAllowedDocUrl("https://crawlee.dev/docs/guides")).toBe(true);
  });

  it("rejects everything else (SSRF guard)", () => {
    expect(isAllowedDocUrl("https://evil.com/")).toBe(false);
    expect(isAllowedDocUrl("http://docs.apify.com/")).toBe(false); // protocol mismatch
    // Suffix attack — caught by origin parsing, not raw startsWith.
    expect(isAllowedDocUrl("https://docs.apify.com.evil.com/")).toBe(false);
    expect(isAllowedDocUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedDocUrl("not a url")).toBe(false);
  });
});

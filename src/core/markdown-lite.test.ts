import { describe, it, expect } from "vitest";
import { renderMarkdown, escapeHtml } from "./markdown-lite";

describe("escapeHtml", () => {
  it("escapes &, <, >, quotes", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml('"x"')).toBe("&quot;x&quot;");
    expect(escapeHtml("'y'")).toBe("&#39;y&#39;");
  });
});

describe("renderMarkdown", () => {
  it("renders headings (h1 → h2, h2 → h3, h3 → h4)", () => {
    const out = renderMarkdown("# top\n## mid\n### sub");
    expect(out).toContain("<h2");
    expect(out).toContain(">top<");
    expect(out).toContain("<h3");
    expect(out).toContain(">mid<");
    expect(out).toContain("<h4");
    expect(out).toContain(">sub<");
  });

  it("renders unordered lists", () => {
    const out = renderMarkdown("- one\n- two\n- three");
    expect(out).toContain("<ul");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>three</li>");
  });

  it("renders ordered lists", () => {
    const out = renderMarkdown("1. first\n2. second");
    expect(out).toContain("<ol");
    expect(out).toContain("<li>first</li>");
  });

  it("renders fenced code blocks with escape", () => {
    const out = renderMarkdown("```js\nconst x = '<a>';\n```");
    expect(out).toContain("<pre");
    expect(out).toContain("&lt;a&gt;");
    // Code body must NOT contain unescaped angle brackets
    expect(out).not.toMatch(/<a>/);
  });

  it("renders inline code", () => {
    const out = renderMarkdown("see `npm install`");
    expect(out).toContain("<code");
    expect(out).toContain("npm install");
  });

  it("renders bold and italic", () => {
    const out = renderMarkdown("**bold** and *italic*");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });

  it("renders safe links", () => {
    const out = renderMarkdown("[Vercel](https://vercel.com)");
    expect(out).toContain('href="https://vercel.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener"');
  });

  it("strips javascript: URLs from links", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#"');
  });

  it("escapes raw HTML in input", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    // Should appear escaped, not as a real script tag
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toMatch(/<script[^>]*>alert/);
  });

  it("renders paragraphs from prose blocks", () => {
    const out = renderMarkdown("First paragraph.\n\nSecond paragraph.");
    expect(out).toContain("<p>First paragraph.</p>");
    expect(out).toContain("<p>Second paragraph.</p>");
  });
});

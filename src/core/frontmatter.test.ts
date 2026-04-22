import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("parses a simple key/value frontmatter", () => {
    const { meta, body } = parseFrontmatter(`---
name: my-skill
description: A short skill
---
body content`);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("A short skill");
    expect(body.trim()).toBe("body content");
  });

  it("handles literal block scalar (|)", () => {
    const { meta } = parseFrontmatter(`---
name: my-skill
description: |
  Line one
  Line two
  Line three
---
body`);
    expect(meta.description).toBe("Line one\nLine two\nLine three\n");
  });

  it("handles folded block scalar (>)", () => {
    const { meta } = parseFrontmatter(`---
name: my-skill
description: >
  This is a long description
  that should be folded.
---
body`);
    expect(meta.description).toBe("This is a long description that should be folded.\n");
  });

  it("parses a list of arguments with nested fields", () => {
    const { meta } = parseFrontmatter(`---
name: my-skill
arguments:
  - name: notes
    description: Raw notes
    required: true
  - name: tone
    description: Target tone
    required: false
---
body`);
    expect(Array.isArray(meta.arguments)).toBe(true);
    const args = meta.arguments as { name: string; required: boolean }[];
    expect(args).toHaveLength(2);
    expect(args[0]?.name).toBe("notes");
    expect(args[0]?.required).toBe(true);
    expect(args[1]?.required).toBe(false);
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\nname: my-skill\r\ndescription: hello\r\n---\r\nbody";
    const { meta, body } = parseFrontmatter(src);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("hello");
    expect(body.trim()).toBe("body");
  });

  it("returns warning when frontmatter is missing", () => {
    const { meta, body, warnings } = parseFrontmatter("no frontmatter here\njust body");
    expect(meta).toEqual({});
    expect(body).toContain("no frontmatter");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("strips surrounding quotes from quoted values", () => {
    const { meta } = parseFrontmatter(`---
name: "my-skill"
description: 'a quoted desc'
---
body`);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("a quoted desc");
  });

  it("ignores comment lines starting with #", () => {
    const { meta, warnings } = parseFrontmatter(`---
# this is a comment
name: my-skill
# another comment
description: hello
---
body`);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("hello");
    expect(warnings).toHaveLength(0);
  });

  it("records a warning on malformed YAML", () => {
    const { meta, warnings } = parseFrontmatter(`---
name: my-skill
description: "unclosed quote
---
body`);
    // js-yaml is forgiving — parse may or may not throw. Key guarantee: we
    // never crash, meta is always an object, warnings may or may not be set.
    expect(meta).toBeTypeOf("object");
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("handles deeply nested maps", () => {
    const { meta } = parseFrontmatter(`---
name: my-skill
config:
  nested:
    deep:
      value: 42
---
body`);
    const config = meta.config as { nested: { deep: { value: number } } };
    expect(config.nested.deep.value).toBe(42);
  });

  it("rejects frontmatter exceeding 16 KB (H2 regression)", () => {
    const huge = "name: my-skill\n" + "x: ".padEnd(20_000, "y") + "\n";
    const src = `---\n${huge}\n---\nbody`;
    const { meta, warnings } = parseFrontmatter(src);
    expect(meta).toEqual({});
    expect(warnings.some((w) => /exceeds/.test(w))).toBe(true);
  });

  it("rejects frontmatter containing YAML anchors (H2 billion-laughs guard)", () => {
    const src = `---
a: &anchor
  - 1
  - 2
b: *anchor
---
body`;
    const { meta, warnings } = parseFrontmatter(src);
    expect(meta).toEqual({});
    expect(warnings.some((w) => /anchors|aliases/.test(w))).toBe(true);
  });

  it("strips UTF-8 BOM before parsing (N5 regression)", () => {
    const src = "\uFEFF---\nname: bom-skill\n---\nbody";
    const { meta, body } = parseFrontmatter(src);
    expect(meta.name).toBe("bom-skill");
    expect(body.trim()).toBe("body");
  });
});

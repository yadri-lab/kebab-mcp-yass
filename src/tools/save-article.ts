import { z } from "zod";
import yaml from "js-yaml";
import { vaultWrite } from "@/lib/github";

const MAX_ARTICLE_SIZE = 5 * 1024 * 1024; // 5MB
const JINA_TIMEOUT = 15_000; // 15 seconds

export const saveArticleSchema = {
  url: z.string().url().describe("URL of the article to save"),
  title: z
    .string()
    .optional()
    .describe("Article title (auto-extracted if omitted)"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to add, e.g. ['ai', 'strategy']"),
  folder: z
    .string()
    .optional()
    .describe('Target folder in vault (default: "Veille/")'),
};

export async function handleSaveArticle(params: {
  url: string;
  title?: string;
  tags?: string[];
  folder?: string;
}) {
  // Fetch article content via Jina Reader with timeout and size limit
  // Auto-detect Medium URLs and inject session cookie
  const isMedium =
    params.url.includes("medium.com") ||
    params.url.includes("towardsdatascience.com") ||
    params.url.includes("betterprogramming.pub") ||
    params.url.includes("levelup.gitconnected.com");

  const jinaUrl = `https://r.jina.ai/${params.url}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), isMedium ? 20_000 : JINA_TIMEOUT);

  const jinaHeaders: Record<string, string> = { Accept: "text/markdown" };
  const mediumSid = process.env.MEDIUM_SID?.trim();
  if (isMedium && mediumSid) {
    jinaHeaders["x-set-cookie"] = `sid=${mediumSid}`;
  }

  let res: Response;
  try {
    res = await fetch(jinaUrl, {
      headers: jinaHeaders,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch article: ${res.status} ${res.statusText}`);
  }

  // Read with size limit
  const contentLength = parseInt(res.headers.get("content-length") || "0");
  if (contentLength > MAX_ARTICLE_SIZE) {
    throw new Error(`Article too large (${Math.round(contentLength / 1024 / 1024)}MB). Max: 5MB`);
  }

  const markdown = await res.text();
  if (markdown.length > MAX_ARTICLE_SIZE) {
    throw new Error(`Article content too large (${Math.round(markdown.length / 1024 / 1024)}MB). Max: 5MB`);
  }

  // Extract title: Jina metadata "Title:" > first # heading > URL hostname
  let title = params.title;
  if (!title) {
    // Jina Reader prepends "Title: ..." at the top of its output
    const jinaTitleMatch = markdown.match(/^Title:\s*(.+)$/m);
    if (jinaTitleMatch) {
      title = jinaTitleMatch[1].trim();
    } else {
      const headingMatch = markdown.match(/^#\s+(.+)$/m);
      title = headingMatch ? headingMatch[1].trim() : new URL(params.url).hostname;
    }
  }

  // Build filename from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9àâäéèêëïîôùûüÿçœæ]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  const folder = params.folder?.replace(/\/$/, "") || "Veille";
  const path = `${folder}/${slug}.md`;
  const date = new Date().toISOString().split("T")[0];

  // Build frontmatter with js-yaml
  const frontmatterObj: Record<string, unknown> = {
    title,
    source: params.url,
    date,
    saved_via: "YassMCP",
  };
  if (params.tags && params.tags.length > 0) {
    frontmatterObj.tags = params.tags;
  }

  const yamlStr = yaml.dump(frontmatterObj, { lineWidth: -1, quotingType: '"', forceQuotes: false }).trimEnd();
  const fullContent = `---\n${yamlStr}\n---\n\n${markdown}`;

  const result = await vaultWrite(path, fullContent, `Save article: ${slug} via YassMCP`);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            title,
            path: result.path,
            source: params.url,
            contentLength: markdown.length,
            message: "Article saved. Use vault_read to analyze, summarize, or extract takeaways.",
          },
          null,
          2
        ),
      },
    ],
  };
}

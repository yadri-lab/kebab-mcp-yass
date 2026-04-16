/**
 * Browser connector schemas — separated from handlers to enable lazy
 * loading of heavy deps (Stagehand ~2.3 MB, Browserbase SDK).
 *
 * The manifest imports only this file at registration time; the actual
 * handler code (and its heavy imports) is loaded on first tool call
 * via dynamic `import()`.
 */
import { z } from "zod";

export const webBrowseSchema = {
  url: z.string().describe("URL to navigate to"),
  scroll_count: z
    .number()
    .optional()
    .describe("Times to scroll down to load more content (default: 0)"),
  context_name: z
    .string()
    .optional()
    .describe(
      "Browser context for session persistence. Use 'linkedin' for LinkedIn, 'default' for anonymous."
    ),
};

export const webExtractSchema = {
  url: z.string().describe("URL to extract data from"),
  instruction: z
    .string()
    .describe(
      "What to extract, in natural language. Example: 'Extract all feed posts with author, content, likes count, and date'"
    ),
  scroll_count: z
    .number()
    .optional()
    .describe("Scroll before extracting to load more content (default: 0)"),
  context_name: z
    .string()
    .optional()
    .describe("Browser context for session persistence (default: 'default')"),
};

export const webActSchema = {
  url: z.string().describe("URL to navigate to before performing actions"),
  actions: z
    .array(z.string())
    .describe(
      'List of actions in natural language, executed in order. Example: ["click on \'Start a post\'", "type \'Hello world\' in the editor", "click Post"]'
    ),
  context_name: z
    .string()
    .optional()
    .describe("Browser context for session persistence (default: 'default')"),
};

export const linkedinFeedSchema = {
  max_posts: z.number().optional().describe("Max posts to return (default: 20, max: 30)"),
};

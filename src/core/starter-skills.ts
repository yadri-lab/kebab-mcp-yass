/**
 * Curated starter skills surfaced during the skill-first onboarding path
 * on /welcome. Designed to work without any connector credentials —
 * they're pure prompt templates the LLM renders and acts on locally.
 *
 * Why hardcoded vs in content/: framework constants, version-pinned
 * with the rest of the app. Editable here, not user-facing.
 */

export interface StarterSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  icon: string;
  arguments: { name: string; description: string; required: boolean }[];
}

export const STARTER_SKILLS: StarterSkill[] = [
  {
    id: "summarize-article",
    name: "summarize-article",
    description:
      "Reads a URL and produces a tight TL;DR with key claims and supporting evidence. Works in any MCP client.",
    icon: "📰",
    arguments: [
      { name: "url", description: "URL of the article to summarize", required: true },
      {
        name: "audience",
        description: "Who the summary is for (e.g. 'CTO', 'general public', 'expert')",
        required: false,
      },
    ],
    content: `Read the article at {{url}} and produce a TL;DR.

Format:
- **Key claim:** one sentence
- **Why it matters:** one sentence
- **Supporting evidence:** 2-3 bullets
- **Caveats:** 1-2 bullets if any

Tailor the language for: {{audience}}.

Be concise. No filler. Cite specific facts.`,
  },
  {
    id: "rewrite-tone",
    name: "rewrite-tone",
    description:
      "Rewrites a piece of text in a different tone (e.g. casual → professional, terse → warm) while preserving meaning.",
    icon: "✍️",
    arguments: [
      { name: "text", description: "The text to rewrite", required: true },
      {
        name: "target_tone",
        description: "Desired tone (e.g. 'professional and warm', 'punchy', 'formal')",
        required: true,
      },
    ],
    content: `Rewrite the following text in a {{target_tone}} tone.

Constraints:
- Preserve all factual content and intent
- Match the requested tone in word choice and structure
- Keep roughly the same length unless the original is bloated
- Do not add new claims or remove substance

Original:
{{text}}

Rewritten version:`,
  },
  {
    id: "extract-action-items",
    name: "extract-action-items",
    description:
      "Pulls action items, owners, and deadlines out of meeting notes or chat transcripts. Returns a clean checklist.",
    icon: "✅",
    arguments: [
      { name: "notes", description: "Meeting notes or chat transcript", required: true },
    ],
    content: `Extract action items from the following notes.

For each action item, identify:
- **Action:** what concretely needs to be done
- **Owner:** who is responsible (or "unassigned" if unclear)
- **Deadline:** when it's due (or "no deadline" if unclear)
- **Context:** one short sentence linking back to why

Format as a markdown checklist. Skip vague items like "we should think about X" — only extract concrete commitments.

Notes:
{{notes}}`,
  },
];

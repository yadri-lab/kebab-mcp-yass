import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import type { Skill } from "../store";
import { computeSkillContentHash } from "../store";
import { getConfig } from "@/core/config-facade";

/**
 * Skills sync — unidirectional push from Kebab (source of truth) to a
 * configured local path. Typically used to mirror skills into a Claude
 * Code installation's skills directory so Claude picks them up natively.
 *
 * Targets are declared via the `KEBAB_SKILLS_SYNC_TARGETS` env var as a
 * JSON array: `[{"name":"claude-code","path":"/Users/x/.claude/skills"}]`.
 */

export const syncTargetSchema = z.object({
  name: z.string().min(1).max(64),
  path: z.string().min(1),
});

export type SyncTarget = z.infer<typeof syncTargetSchema>;

const syncTargetsSchema = z.array(syncTargetSchema);

/** Load configured sync targets. Returns [] on any parse failure. */
export function listSyncTargets(): SyncTarget[] {
  const raw = getConfig("KEBAB_SKILLS_SYNC_TARGETS")?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const res = syncTargetsSchema.safeParse(parsed);
    if (!res.success) return [];
    return res.data;
  } catch {
    return [];
  }
}

/** Look up a single target by name. */
export function getSyncTarget(name: string): SyncTarget | null {
  return listSyncTargets().find((t) => t.name === name) ?? null;
}

/**
 * Build the frontmatter + body that gets written to the local target.
 * Format is a YAML-like frontmatter block — compatible with Claude Code
 * skills, Obsidian notes, and any Markdown tooling.
 */
export function renderSkillMarkdown(skill: Skill): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${skill.id}`);
  lines.push(`display_name: ${JSON.stringify(skill.name)}`);
  if (skill.description) {
    lines.push(`description: ${JSON.stringify(skill.description)}`);
  }
  if (skill.arguments.length > 0) {
    lines.push("arguments:");
    for (const arg of skill.arguments) {
      lines.push(`  - name: ${arg.name}`);
      if (arg.description) {
        lines.push(`    description: ${JSON.stringify(arg.description)}`);
      }
      lines.push(`    required: ${arg.required ? "true" : "false"}`);
    }
  }
  if (skill.toolsAllowed && skill.toolsAllowed.length > 0) {
    lines.push("tools_allowed:");
    for (const t of skill.toolsAllowed) {
      lines.push(`  - ${t}`);
    }
  }
  lines.push(`kebab_version: ${skill.updatedAt}`);
  lines.push("---");
  lines.push("");

  // For remote skills, fall back to cached content.
  const body =
    skill.content || (skill.source.type === "remote" ? (skill.source.cachedContent ?? "") : "");

  lines.push(body);
  return lines.join("\n") + "\n";
}

/**
 * Validate that `targetPath` is a directory we're actually allowed to
 * write into. Guards against unresolved envs and blatantly unsafe paths
 * (e.g. root `/`). Does NOT prevent sandbox escapes — the operator
 * configures their own paths and owns that trust boundary.
 */
function assertSafeTargetPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (resolved === "") {
    throw new Error("refuses to sync to empty path");
  }
  // Reject filesystem roots: POSIX "/", Windows "C:\", "D:\", etc.
  if (resolved === "/" || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
    throw new Error("refuses to sync to root path");
  }
  return resolved;
}

export interface SyncResult {
  target: string;
  filePath: string;
  hash: string;
  syncedAt: string;
}

/**
 * Write `<target>/<skill_id>.md` with the current skill content +
 * frontmatter. Creates the directory if missing. Returns the new sync
 * state payload so the caller can persist it via recordSkillSyncState.
 */
export async function syncSkillToTarget(skill: Skill, target: SyncTarget): Promise<SyncResult> {
  const dir = assertSafeTargetPath(target.path);
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${skill.id}.md`);
  const content = renderSkillMarkdown(skill);
  await fs.writeFile(filePath, content, "utf-8");

  return {
    target: target.name,
    filePath,
    hash: computeSkillContentHash(skill),
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Phase 68 / Plan 04 / Task 1 — KV-backed audit log writer + dedup checker.
 *
 * Six exports:
 *  - `AUDIT_TTL_SECONDS` — literal 90-day constant (D-08), exported so tests
 *    can assert the value passed to `kv.set` (Pitfall 7: FilesystemKV ignores
 *    TTL — verifying the value is the only reliable check).
 *  - `AuditResult` — locked enum (D-15). NEVER add `'pending'`; D-13/D-14
 *    deliberately eliminated that state to prevent ambiguous "probably sent"
 *    semantics (the 2026-05-18 Antoine Vercken Browserbase incident).
 *  - `AuditRow` — locked row schema (D-07). NEVER add a `note` or `note_text`
 *    field. The note's SHA-256-truncated `params_hash` is the only PII that
 *    leaves the function — caller (CRM) holds the source text.
 *  - `generateAuditId()` — UUIDv4 via node:crypto randomUUID.
 *  - `computeParamsHash({tool, profile_url_normalized, note})` — deterministic
 *    SHA-256 → 16 hex chars. Keys are sorted before stringify so insertion
 *    order does not matter (D-05).
 *  - `writeAuditRow(row)` — dual KV write (row at `unipile:audit:<id>` + hash
 *    pointer at `unipile:audit:hash:<params_hash>`), both with 90-day TTL.
 *    Both values are the full row JSON — one KV read in `checkDedup` serves
 *    the dedup-check AND the prior-result display in one shot (see SUMMARY).
 *  - `checkDedup(params_hash)` — reads the hash pointer; returns the prior
 *    `AuditRow` on hit, `null` on miss / corrupt JSON / shape mismatch.
 *
 * Tenant isolation: ALL KV access goes through `getContextKVStore()` (D-18).
 * On-disk keys become `tenant:<id>:unipile:audit:<audit_id>`. Tenant A cannot
 * read tenant B's audit history.
 *
 * D-06: there is NO `dedup_key`, `bypassDedup`, or `forceWrite` symbol in
 * this module. The LLM caller CANNOT bypass dedup. Verified at the export
 * level by `audit.test.ts` and at the TypeScript signature level by the
 * absence of any such parameter.
 */

import { createHash, randomUUID } from "node:crypto";
import { getContextKVStore } from "@/core/request-context";

/** D-08: audit log TTL is 90 days. Upstash respects EX; FilesystemKV ignores (dev only). */
export const AUDIT_TTL_SECONDS = 90 * 24 * 60 * 60; // 7,776,000

/**
 * D-15: result enum (locked phase-68 order — extended in phase 69 / Plan 01).
 *
 * NEVER add 'pending' — D-13/D-14 eliminate that state.
 *
 * Phase 69 additions (D-23, D-26, D-29, D-32, D-43, D-45) appended below the
 * phase-68 members; ordering of phase-68 members is preserved so existing
 * dashboards / audit-log queries that rely on declaration order continue to
 * work. Discriminator strings (alphabetical inside the phase-69 block) chosen
 * to keep the surface scannable.
 */
export type AuditResult =
  // Phase 68 (locked — DO NOT reorder)
  | "success"
  | "unverified_timeout"
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx"
  // Phase 69 — CONTEXT-mandated (7 new, alphabetical)
  | "dry_run" // D-32 — engage dry_run audit row (no provider call)
  | "error_attachment_too_large" // D-23
  | "error_inmail_not_authorized" // D-26
  | "error_inmail_requires_premium" // D-29
  | "error_invalid_request" // D-45 (UNI-26)
  | "error_rate_limit_kebab" // D-43 — distinct from Unipile-side 429
  | "error_recipient_unreachable" // D-45 (UNI-26)
  // Phase 69 — Claude's discretion (RESEARCH §6 recommended, 2 bonus)
  | "error_inmail_recipient_not_eligible"
  | "error_inmail_cap_exceeded";

/** D-07: audit row schema. note_text is NEVER persisted — only params_hash. */
export interface AuditRow {
  audit_id: string;
  actor_user_id: string;
  tool: string;
  account_id: string;
  params_hash: string;
  result: AuditResult;
  verified: boolean;
  dedup_hit: boolean;
  timestamp: string; // ISO-8601 UTC
}

/** Generate a UUIDv4 audit_id. */
export function generateAuditId(): string {
  return randomUUID();
}

/**
 * D-05: SHA-256 over {tool, profile_url_normalized, note}, truncated to 16 hex chars.
 *
 * Deterministic — keys are sorted alphabetically before stringify so the
 * caller's object-literal insertion order does not influence the hash. This
 * matters because TC39 specifies own-string-key iteration order, but
 * defensive sorting future-proofs against engine quirks and re-ordering
 * refactors.
 *
 * Caller MUST pass the already-normalized profile URL (see
 * `identifiers.ts → normalizeProfileUrl`). Pass `note: ""` when no note is
 * provided — empty string is canonical.
 *
 * 1-char note change = new hash = new call allowed (D-05 design: protects
 * against re-spam with the SAME note while preserving legitimate
 * re-engagement with a different message). 16 hex chars = 64 bits,
 * birthday-bound at ~4.3 B entries (far above Cadens scale ceiling).
 */
export function computeParamsHash(input: {
  tool: string;
  profile_url_normalized: string;
  note: string;
}): string {
  // Canonical form: sort keys alphabetically before stringify
  const canonical = JSON.stringify({
    note: input.note,
    profile_url_normalized: input.profile_url_normalized,
    tool: input.tool,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Dual KV write: the audit row + a hash-pointer index pointing back to the
 * same row. Both expire after 90 days (D-08). Tenant-scoped via
 * `getContextKVStore()` (D-18).
 *
 * Design choice: the hash pointer stores the FULL row JSON (not just the
 * audit_id). Trade-off: 2× storage cost for the row body. Win: one KV read
 * in `checkDedup` covers both the dedup-check AND prior-result display
 * (e.g. "your last call on 2026-05-01 returned `success`"). At Cadens scale
 * (max 30 sends/day × 90 days = 2,700 rows × ~300 bytes = ~800 KB), the
 * doubled cost is negligible. Documented in 68-04-SUMMARY.md.
 *
 * The two writes are issued in parallel via Promise.all. There is no
 * cross-row atomicity (KV is not a transactional store) — failure of either
 * write propagates to the caller. Phase 06 will handle this at the call
 * site (the tool handler logs and surfaces the error).
 */
export async function writeAuditRow(row: AuditRow): Promise<void> {
  const kv = getContextKVStore();
  const rowJson = JSON.stringify(row);
  await Promise.all([
    kv.set(`unipile:audit:${row.audit_id}`, rowJson, AUDIT_TTL_SECONDS),
    kv.set(`unipile:audit:hash:${row.params_hash}`, rowJson, AUDIT_TTL_SECONDS),
  ]);
}

/**
 * Look up a prior audit row by params_hash. Returns the row if present,
 * `null` if absent / corrupt JSON / shape mismatch.
 *
 * Used by tool handlers (Plan 06) to enforce dedup BEFORE the Unipile call.
 * D-05/D-06: dedup is enforced HERE, not by the caller. There is no
 * parameter on this function to bypass the check.
 *
 * Shape-defensive fallback to `null` matters because corrupt rows (manual
 * KV edits, partial writes interrupted by Vercel timeouts, schema drift in
 * future plans) should fail OPEN — i.e. allow the call to proceed and
 * re-write a clean row — rather than block forever on garbage state.
 */
export async function checkDedup(paramsHash: string): Promise<AuditRow | null> {
  const kv = getContextKVStore();
  const raw = await kv.get(`unipile:audit:hash:${paramsHash}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuditRow;
    if (parsed && typeof parsed.audit_id === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

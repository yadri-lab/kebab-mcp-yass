# Phase 68: Unipile Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `68-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-05-18
**Phase:** 68-unipile-foundation
**Areas discussed:** CRM Bridge V1 (Twenty), Audit log granularity + retention, Identifiers cache (LRU), Verify-after-write semantics
**Mode:** Standard interactive discuss (4 areas × ~3 questions each, batched per area)

---

## CRM Bridge V1 (Twenty)

### Q1: Twenty integration mode for phase 68
| Option | Description | Selected |
|--------|-------------|----------|
| Webhook outbox (suit l'ADR) | Kebab POST `{audit_id, event_type, payload}` sur `UNIPILE_CRM_WEBHOOK_URL`, HMAC signed. Decoupled, retry-friendly. | |
| API REST Twenty directe | Kebab calls Twenty REST API directly. Simpler bootstrap, tighter coupling. | |
| Logger only, pas d'intégration Twenty en phase 68 | Phase 68 = audit log + `crm_log: 'pending'`. Twenty actual integration deferred to phase 70. | ✓ |

**User's choice:** Logger only — defer Twenty work to phase 70.
**Notes:** User then locked the future mode anyway (D-02 webhook outbox) and the HMAC scope (D-03 per-tenant) — bonne discipline ; anchors the interface design even though the wire-up is deferred.

### Q2: HMAC secret scope (for when phase 70 lands)
| Option | Description | Selected |
|--------|-------------|----------|
| Per-tenant (`UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>`) | Consistent with v0.11 multi-tenant. One leak = isolated to one tenant. | ✓ |
| Global (`UNIPILE_CRM_WEBHOOK_SECRET`) | Simpler. One secret, all tenants share. | |
| N/A | Skip if logger-only chosen. | |

**User's choice:** Per-tenant.

### Q3: Retry strategy on CRM webhook failure
| Option | Description | Selected |
|--------|-------------|----------|
| Retry exponentiel via cron (1min, 5min, 30min) | Reuse cron pattern from phase 63. `status: dead` after 3 failures. | ✓ |
| Une seule tentative, status `failed` final | No auto retry. User replays manually via admin tool. | |
| Repousser la décision à phase 70 | Phase 70 owns it; not relevant to 68. | |

**User's choice:** Cron exponential — pattern locked for phase 70 implementation.

---

## Audit Log

### Q1: `params_hash` scope (dedup granularity)
| Option | Description | Selected |
|--------|-------------|----------|
| Tool + profile_url + note (strict) | Same profile + same note = dedup. Note text change = new call. | ✓ |
| Tool + profile_url uniquement (large) | Same profile = dedup regardless of note. | |
| Tool + profile_url + dedup_key fallback | Caller controls dedup via optional `dedup_key`. | |

**User's choice:** Strict — no `dedup_key` override allowed (D-06 consequence).
**Notes:** Trade-off: re-engagement campaigns 90 days later must change the note or be blocked.

### Q2: PII handling in audit (notes contain prospect names)
| Option | Description | Selected |
|--------|-------------|----------|
| Hash only, never plain text (Recommended) | Only `params_hash` in KV. Caller (CRM) holds source text. | ✓ |
| Plain text + KMS encrypted at-rest | Note in clear, encrypted via Vercel KMS. Better forensics, more PII surface. | |
| Truncated 50 chars in clear | Preview for debug, less PII. | |

**User's choice:** Hash only — RGPD-clean.

### Q3: Audit log TTL in KV
| Option | Description | Selected |
|--------|-------------|----------|
| 90 days (Recommended) | RGPD-friendly, investigation window 1-3 mo. Auto-purge via Upstash TTL. | ✓ |
| 30 days | Stricter, but loses long-tail investigation. | |
| Indef (no TTL) | Keeps everything. ~12k entries/year at Cadens scale = negligible cost. | |
| Configurable env var | Defaults to 90, overridable. | |

**User's choice:** 90 days, no env override in phase 68 (defaults-only).

---

## Identifiers Cache (profile_url → URN)

### Q1: Cache backing store
| Option | Description | Selected |
|--------|-------------|----------|
| KV Upstash only (Recommended) | Persistent cross-lambda. Consistent with rest of Kebab. | ✓ |
| In-memory LRU + KV fallback (2-tier) | Warm lambda fast, but lambdas don't share RAM on Vercel. | |
| KV JSON Bag (1 key) | 1 shared key holding `{url:urn}` map. Doesn't scale. | |

**User's choice:** KV only.

### Q2: TTL + cache miss + Unipile 429 behavior
| Option | Description | Selected |
|--------|-------------|----------|
| TTL 30d, miss → Unipile + write KV, 429 = explicit error (Recommended) | Honest failure. Rate limits surface loudly. | ✓ |
| TTL 30d, stale-if-error on 429 | Use expired entry on rate limit. More resilient, complex TTL bookkeeping. | |
| TTL 7d, 429 = error | Shorter, multiplies Unipile calls. | |

**User's choice:** TTL 30d, strict 429 error.

### Q3: Manual cache invalidation surface
| Option | Description | Selected |
|--------|-------------|----------|
| Admin REST endpoint `/api/admin/unipile/cache/urn` (Recommended) | Consistent with other admin endpoints. Maintenance op, not LLM-visible. | ✓ |
| MCP tool `unipile_cache_evict` | Exposes maintenance to LLM. More powerful but exposes plumbing. | |
| No invalidation in phase 68 | YAGNI. TTL self-purges. | |

**User's choice:** Admin REST endpoint.

---

## Verify-After-Write Semantics

### Q1: Who re-polls if 3-poll timeout?
| Option | Description | Selected |
|--------|-------------|----------|
| Cron quotidien re-polls `pending` < 24h | Audit log is source of truth. Auto-rectify. | |
| Pas de re-poll auto — caller re-call si besoin | Simpler. Pushes complexity to caller. | ✓ |
| Webhook Unipile `new_relation` (phase 70) | Different event (accepted, not sent). | |

**User's choice:** No auto re-poll.

### Q2: CRM display when state is "pending"
| Option | Description | Selected |
|--------|-------------|----------|
| "Envoyée (en cours)" — orange icon | Honest about uncertainty. | ✓ (initial answer, then overruled in Q4) |
| "Envoyée" — no visual distinction | Optimistic UX. | |
| Don't show until `verified: true` | Conservative. | |

**User's choice:** Initially orange, then overruled in Q4.

### Q3: Anti-Antoine-Vercken — what's different here?
| Option | Description | Selected |
|--------|-------------|----------|
| Strict verify + warning metric on unverified | Observability signal even when returning `pending`. | |
| **Stricter: `verified: false` on 3-poll timeout** | No more `'pending'`. Timeout = failure. Caller must retry. | ✓ |
| Standard ADR (pending + next_check_at) | Stick to original plan. | |

**User's choice:** Strict — eliminate `'pending'` entirely.

### Q4: Resolve contradiction (no re-poll + verified: false + orange UI)
| Option | Description | Selected |
|--------|-------------|----------|
| **Keep `verified: false` strict, CRM shows "Erreur - retry"** | Assume severity. No more ambiguous orange. | ✓ |
| Reintroduce `pending` but no auto-poll | Three states again. CRM shows orange. Caller can refresh. | |
| Binary + transparent retry (50s max latency) | Tool does 2 rounds of 3 polls internally. | |

**User's choice:** Strict false + "retry" red icon. Locks the anti-Antoine-Vercken principle hard.

---

## Claude's Discretion

Delegated to Claude (no user input needed):
- Hashing function choice (SHA-256 recommended, truncated to 16 hex chars for KV key efficiency)
- Internal retry middleware structure (axios/fetch/SDK-native, whatever fits)
- Error code taxonomy for `result` field
- Test layering split (unit vs integration vs manual E2E)

## Deferred Ideas

- Twenty CRM actual integration → phase 70
- In-memory LRU tier → rejected (not phase 68, not later either at this scale)
- `unipile_audit_today` tool → phase 71 (UNI-22)
- Configurable `UNIPILE_AUDIT_TTL_DAYS` → add only if a tenant requests
- `dedup_key` override → explicitly rejected (D-06)
- Auto re-poll cron for `pending` → N/A (we eliminated `pending`)

# tests/regression — One test per session bug

This directory holds one regression test file per theme from
`.planning/phases/40-test-coverage-docs/BUG-INVENTORY.md`. Each bug
identified in the 2026-04-20 durability debugging session has exactly
one named test across these files:

| Theme                     | File                       | Bug count | BUGs covered                   |
|---------------------------|----------------------------|-----------|--------------------------------|
| `welcome-flow`            | `welcome-flow.test.ts`     | 6         | BUG-01..BUG-06                 |
| `storage-ux`              | `storage-ux.test.ts`       | 3         | BUG-12, BUG-13, BUG-16         |
| `kv-durability`           | `kv-durability.test.ts`    | 4         | BUG-07, BUG-08, BUG-14, BUG-15 |
| `bootstrap-rehydrate`     | `bootstrap-rehydrate.test.ts` | 2      | BUG-10, BUG-11                 |
| `env-handling`            | `env-handling.test.ts`     | 2         | BUG-09, BUG-17                 |

## Contract

- **One `it()` per bug.** Assertion name starts with the BUG-NN ID so
  `grep -r "regression: BUG-" tests/regression/` yields exactly the
  inventory count.
- **Live tests, not snapshots.** Each test exercises current code; a
  `git revert <bug-fix-sha>` on the session's fix commits would make
  the corresponding test re-fail.
- **File header references the inventory.** Test file docstring lists
  the BUG-NNs + SHAs covered. Any BUG row in the inventory must find
  its test via grep.

## Testing strategy per bug class

- **Route handler bugs** (init 409, init 500): import the handler +
  `fetch`-call with a fabricated Request. Assert status + body.
- **Middleware bugs** (proxy.ts redirects, ?token= strip): import
  `proxy()` from `proxy.ts` + call with a NextRequest shim. Assert
  response status + headers + set-cookie.
- **Bootstrap-primitive bugs** (rehydrate from KV, await flush): test
  against `src/core/first-run.ts` exports with an injected shared KV.
- **UI-only bugs** (paste-token form, storage-step redesign): for
  component-scoped logic that's not exported, we use a parallel re-
  implementation of the pure function under test + a grep-contract
  on the source file asserting the fix-era variable names remain.
  Each such assertion is annotated with a FOLLOW-UP note to extract
  the helper to `src/core/` for a proper direct-import test.

## Running

```bash
npm run test:unit -- tests/regression/
```

All five files run as part of the default vitest suite (no special
config).

## Adding a new regression

When a new production bug ships:

1. Add a BUG-NN row to `.planning/phases/40-test-coverage-docs/BUG-INVENTORY.md`
   (or the next phase's equivalent inventory).
2. Pick the closest theme; add one `it()` to that theme's file.
3. Include the commit SHA in the test file docstring header so the
   mapping is traceable.

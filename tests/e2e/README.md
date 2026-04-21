# tests/e2e — Playwright end-to-end tests

This directory holds black-box Playwright specs that drive the real
dev server against a real browser. They are **state-mutating** — they
set cookies, may trigger `/api/welcome/init`, and assume a
running dev server — so they are kept **separate** from the visual
snapshot tests in `tests/visual/`.

## Prerequisites

- A running dev server at `http://localhost:3000`, OR a `PLAYWRIGHT_BASE_URL`
  env var pointing at a live instance.
- `MCP_AUTH_TOKEN` set in the dev server's `.env` (otherwise `/welcome`
  sits in first-run mode and the return-visitor assertions skip).
- Chromium installed: `npx playwright install chromium`.

## Run

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run test:e2e
```

The `test:e2e` script targets the Playwright `e2e` project
(`playwright.config.ts`), which has `testDir: "tests/e2e"` and
`retries: 1` in CI.

## State reset between runs

The welcome flow is stateful — a completed init on one run affects
the next. To fully reset:

1. Delete the admin cookie on your test browser profile
   (`mymcp_admin_token`).
2. If you have Upstash attached, delete the bootstrap key:
   `mymcp:firstrun:bootstrap`. A `npm run kv:compact` flush or a
   direct `redis-cli del` works.
3. On Vercel / persistent deploys, `MYMCP_RECOVERY_RESET=1` on the
   next cold start wipes the bootstrap (see BUG-05 in
   `docs/TROUBLESHOOTING.md`).
4. Restart the dev server — the process-local `bootstrapAuthTokenCache`
   and `/tmp/.mymcp-bootstrap.json` are both transient.

## Cold-start mid-flow

The cross-lambda cold-start-after-reap scenario (regression for
BUG-10 / BUG-11) is **not** implemented as a Playwright spec because
it would require restarting the dev server mid-test, which isn't
feasible against a user-owned `npm run dev` process and would
corrupt any dev state the operator had loaded in memory.

The equivalent behavior has full coverage in
`tests/integration/welcome-durability.test.ts` (TEST-01), which
simulates the cold-start by resetting the Node module graph and
clearing `/tmp` between "Lambda A" and "Lambda B". That test proves
the persistence boundary holds — the Playwright spec here proves
the user-visible flow renders + handoff works end-to-end.

If you want the scenario end-to-end anyway, the template is:

```ts
test("cold-start mid-flow preserves claim cookie", async ({ page }) => {
  test.skip(
    !process.env.E2E_ALLOW_SERVER_RESTART,
    "Requires E2E_ALLOW_SERVER_RESTART=1 and a helper to SIGHUP the dev server"
  );
  // 1. Visit /welcome, accept storage, mint claim cookie.
  // 2. Trigger server restart (external helper: `pm2 restart`, `docker kill -HUP`).
  // 3. Navigate back to /welcome — the claim should still be valid
  //    (BUG-15 — HMAC trusted across cold lambdas).
});
```

## Included regression targets

| Spec               | Regression for                                                       |
|--------------------|----------------------------------------------------------------------|
| `welcome.spec.ts`  | bc31b69 (paste-token form), 4e6fa0c (URL paste), 83b5a8e (handoff), f818e01 (step-3 gate), ccdaa3d / c339fc7 / 0b5c737 (storage-step UX) |

See `.planning/phases/40-test-coverage-docs/BUG-INVENTORY.md` for
the full symptom / root-cause / fix-commit map.

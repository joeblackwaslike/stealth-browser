# Gateway CAPTCHA Solver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gateway solves reCAPTCHA v2 challenges (including Google's `/sorry/` page) for any profile through a provider-agnostic solver, with a `google` profile and a per-hour spend cap.

**Architecture:** `detectChallenge` (pure) finds a challenge in fetched HTML. `src/browser.ts` calls a `Solver` while the page is still open, injects the token, submits, and re-reads the page. `app.ts` classification runs afterward unchanged, so a failed solve ends in the existing `blocked` verdict and 30-minute pause.

**Tech Stack:** TypeScript, Hono, Playwright (`playwright-core`), vitest, zod, `@t3-oss/env-core`. pnpm from the repo root. Biome and `tsc --noEmit` for static checks.

**Spec:** `docs/superpowers/specs/2026-11-03-captcha-solver-design.md`

## Global Constraints

- Proxies stay out of scope; all traffic leaves from the home IP.
- No per-site parsers in the gateway.
- A failed, refused, or over-budget solve must return the original page so `classifyPage` yields `blocked` and `scheduler.pause` runs (existing behavior, `src/app.ts:126`).
- No key means no solver: `SOLVER_API_KEY` unset leaves behavior identical to today.
- Defaults (my calls): `SOLVER_BASE_URL=https://2captcha.com`, `SOLVER_MAX_PER_HOUR=20`, `google` profile gap `[8000, 15000]` ms, solver timeout 120000 ms.
- Secrets never appear in logs or thrown errors (match the ws-endpoint redaction pattern in `src/browser.ts:27`).
- JS tooling: pnpm, no npm/npx/yarn/tsx. Tests: `pnpm test`.

## Review Focus

- Solver returns no token before its timeout: the fetch still returns the original page, verdict `blocked`, profile paused.
- Hour budget exhausted: no network call to the solver, original page returned, a warn log.
- Page has a challenge but no `data-sitekey` (malformed): `detectChallenge` returns `null`, not a throw.
- Challenge appears again after one solve: solve at most once per fetch, return the second page as is.
- Solver API key in an error message from the provider: redacted before it reaches logs.

---

### Task 1: `google` profile

**Files:**
- Modify: `src/profiles.ts`
- Test: `test/profiles.test.ts`

**Interfaces:**
- Produces: `ProfileName` now `"ebay" | "reddit" | "anon" | "google"`; `PROFILES.google`.

- [ ] **Step 1: Failing tests in `test/profiles.test.ts`**
  - `profileForUrl(new URL("https://www.google.com/search?q=x"))` returns `"google"`.
  - `profileForUrl(new URL("https://notgoogle.com/"))` returns `"anon"`.
  - `PROFILES.google` has `minGapMs` `[8000, 15000]` and `requiresLogin` `false`.
- [ ] **Step 2: Run** `pnpm vitest run test/profiles.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Add** a `google` entry to `PROFILES` and widen `ProfileName` in `src/profiles.ts`. Fix any exhaustive-switch compile error `tsc` reports.
- [ ] **Step 4: Run** `pnpm vitest run test/profiles.test.ts && pnpm tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(profiles): add google profile with its own pacing`.

### Task 2: `detectChallenge`

**Files:**
- Modify: `src/detect.ts`
- Create: `test/fixtures/google-sorry.html`, `test/fixtures/recaptcha-widget.html`
- Test: `test/detect.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Challenge = {
    type: "recaptcha_v2";
    sitekey: string;
    pageUrl: string;
    dataS?: string;
  };
  export function detectChallenge(html: string, finalUrl: string): Challenge | null;
  ```

- [ ] **Step 1: Fixtures.** `google-sorry.html` is a minimal page shaped like Google's `/sorry/index`: a `<form id="captcha-form">` containing `<div class="g-recaptcha" data-sitekey="SITEKEY123" data-s="DATAS456">`. `recaptcha-widget.html` has the same widget without `data-s`.
- [ ] **Step 2: Failing tests in `test/detect.test.ts`**
  - Sorry fixture with `finalUrl` `https://www.google.com/sorry/index?continue=x` returns `{ type: "recaptcha_v2", sitekey: "SITEKEY123", pageUrl: <that url>, dataS: "DATAS456" }`.
  - Widget fixture returns the same without `dataS`.
  - HTML with `class="g-recaptcha"` and no `data-sitekey` returns `null`.
  - `ebay-challenge.html` returns `null` (not a solvable type).
  - `reddit-search-ok.html` returns `null`.
- [ ] **Step 3: Run** `pnpm vitest run test/detect.test.ts`. Expected: FAIL, `detectChallenge` not exported.
- [ ] **Step 4: Implement** `detectChallenge` in `src/detect.ts`: strip scripts/styles with the existing helper, find the element with class `g-recaptcha`, read `data-sitekey` and optional `data-s` from that tag's attributes. Do not change `classifyPage`.
- [ ] **Step 5: Run** the test file. Expected: PASS.
- [ ] **Step 6: Commit** `feat(detect): detect solvable reCAPTCHA v2 challenges`.

### Task 3: Solver interface, 2Captcha adapter, budget, config

**Files:**
- Create: `src/solver/types.ts`, `src/solver/two-captcha.ts`, `src/solver/budget.ts`, `src/solver/index.ts`
- Modify: `src/config.ts`
- Test: `test/solver.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `Challenge` from `src/detect.ts` (Task 2).
- Produces:
  ```ts
  export interface Solver { solve(challenge: Challenge): Promise<string>; }
  export class SolveBudgetExceededError extends Error {}
  export function createTwoCaptchaSolver(opts: {
    apiKey: string; baseUrl: string; timeoutMs?: number; pollIntervalMs?: number;
    fetchImpl?: typeof fetch;
  }): Solver;
  export function withBudget(solver: Solver, maxPerHour: number, now?: () => number): Solver;
  export function createSolver(config: Config, now?: () => number): Solver | undefined;
  // Config gains: solverApiKey?: string; solverBaseUrl: string; solverMaxPerHour: number
  ```

- [ ] **Step 1: Check the provider API.** Read the current 2Captcha reCAPTCHA v2 docs (context7 or the vendor docs) and confirm the submit and poll parameters (`method=userrecaptcha`, `googlekey`, `pageurl`, `data-s`, `json=1`, poll `res.php?action=get`, the "CAPCHA_NOT_READY" status). Note any difference from this plan in the commit message.
- [ ] **Step 2: Failing tests in `test/solver.test.ts`** with an injected fake `fetchImpl` and `pollIntervalMs: 0`:
  - Submit returns `{status:1, request:"42"}`, first poll returns `CAPCHA_NOT_READY`, second returns the token `"TOKEN"`. `solve(...)` resolves `"TOKEN"`; the submit request carries `googlekey`, `pageurl`, and `data-s` when `dataS` is set.
  - Submit returns an error status: `solve` rejects, and the rejection message does not contain the api key.
  - Polling never returns a token within `timeoutMs`: `solve` rejects.
  - `withBudget(fake, 2, now)`: third call within the same hour rejects with `SolveBudgetExceededError` and the underlying solver is not called; after `now` advances one hour the call succeeds.
  - `createSolver` returns `undefined` when `solverApiKey` is unset.
- [ ] **Step 3: Failing tests in `test/config.test.ts`**: `SOLVER_API_KEY` is optional; `SOLVER_BASE_URL` defaults to `https://2captcha.com`; `SOLVER_MAX_PER_HOUR` defaults to `20` and rejects non-positive values.
- [ ] **Step 4: Run** `pnpm vitest run test/solver.test.ts test/config.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement** the files above. The adapter uses the global `fetch` unless `fetchImpl` is given; it replaces the api key with `<solver-key>` in any error message it throws. `withBudget` keeps a list of call timestamps and drops those older than one hour.
- [ ] **Step 6: Run** both test files plus `pnpm tsc --noEmit`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(solver): add 2Captcha-compatible solver with hourly budget`.

### Task 4: Solve in the browser layer, wire through the app

**Files:**
- Modify: `src/browser.ts`, `src/app.ts`, `src/server.ts`
- Test: `test/browser.test.ts`, `test/app.test.ts`

**Interfaces:**
- Consumes: `detectChallenge` (Task 2), `Solver`, `createSolver` (Task 3).
- Produces:
  ```ts
  // browser.ts
  export type FetchRequest = { /* existing fields */ solver?: Solver };
  // app.ts
  export type AppDeps = { /* existing fields */ solver?: Solver };
  ```
  Behavior: after `page.waitForTimeout`, when `req.solver` is set and `detectChallenge(html, page.url())` is non-null, call `solver.solve` once, set `textarea#g-recaptcha-response` to the token (create it inside the form when absent), submit the form containing `.g-recaptcha`, wait for `domcontentloaded`, then read `html`, `finalUrl`, `status` from the resulting page. If the solver throws, return the pre-solve page. The request deadline when `req.solver` is set adds 120000 ms.

- [ ] **Step 1: Failing tests in `test/browser.test.ts`.** The existing file shows how Playwright is faked; follow it. Cases: with a fake page whose first `content()` has the sorry fixture and a fake solver returning `"TOKEN"`, the fetcher calls the solver once and returns the second page's HTML; a solver that rejects leaves the first page's HTML in the result; no `solver` in the request means no solver call and no form submit.
- [ ] **Step 2: Failing test in `test/app.test.ts`.** A fetcher fake that records `req.solver` shows `createApp({..., solver})` passes `deps.solver` into every `fetcher` call; with no `solver` dep, the request has `solver: undefined`.
- [ ] **Step 3: Run** `pnpm vitest run test/browser.test.ts test/app.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the browser step and the `app.ts` and `server.ts` wiring (`createSolver(config)` result passed as `solver`). Log `solver: solved|failed|skipped` at info level in `done()` without the token.
- [ ] **Step 5: Run** `pnpm test && pnpm tsc --noEmit && pnpm biome check .`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(gateway): solve challenges in the browser layer when a solver is set`.

### Task 5: Deploy config and docs

**Files:**
- Modify: `deploy/k8s/gateway-deployment.yaml`, `README.md`, `docs/superpowers/specs/2026-10-16-stealth-browser-design.md` (non-goal line 45 gets a pointer to the new spec)

- [ ] **Step 1: Add** optional env `SOLVER_API_KEY` (from a Secret key marked `optional: true`), `SOLVER_BASE_URL`, `SOLVER_MAX_PER_HOUR` to the gateway deployment.
- [ ] **Step 2: README**: add a Solver section (env vars, the failure behavior, the Google terms note) and the `google` profile row in the profiles table.
- [ ] **Step 3: Check** with `kubectl kustomize deploy/k8s | head -60` and confirm it renders with the new env entries.
- [ ] **Step 4: Commit** `docs(solver): document solver config and the google profile`.

### Task 6: Live check against Google

Needs Joe's 2Captcha account key: creating the account and funding it are the human-only steps. Everything else is the agent's.

**Files:**
- Create: `scripts/solver-check.ts`

- [ ] **Step 1: Write** `scripts/solver-check.ts`. It sends sequential `POST /content` requests for a Google results URL to a deployed gateway (`STEALTH_BROWSER_URL`, `STEALTH_BROWSER_TOKEN`) and prints each status plus whether a challenge was solved.
- [ ] **Step 2: Deploy** with `SOLVER_API_KEY` set. Run the script until a `/sorry/` page shows up in the gateway log as `solver: solved` or `solver: failed`.
- [ ] **Step 3: Record** the result in the README Solver section (works, or does not and with what error) and commit `docs(solver): record the live /sorry result`. If solving fails on `/sorry`, stop and report the error before the SearXNG plan starts.

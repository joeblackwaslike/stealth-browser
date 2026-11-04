# Host config, solve by default, HTML on every block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pacing and pause policy attach to a host entry, the solver runs on any host but only on challenge forms, and every 423 returns the page HTML and the matched marker.

**Architecture:** `detect.ts` gains a pure HTML challenge-form guard and a `marker` on blocked verdicts. The scheduler is keyed by a string (profile name, or hostname for `anon`) and takes its gap per call. `app.ts` pauses only profiles marked `pauseOnBlock`, always hands the solver to the fetcher, and builds the richer 423 body.

**Tech Stack:** TypeScript, Hono, Playwright, vitest, biome, zod, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-03-host-config-and-block-html-design.md`

## Global Constraints

- Host table: ebay.com 20-40 s and pause after an unsolved block, reddit.com 5-10 s and pause, google.com 8-15 s and no pause, everything else 3-8 s and no pause tracked per hostname.
- The `profile` field keeps its four values: `ebay`, `reddit`, `google`, `anon`. Saved logins (`ebay.json`, `reddit.json`) are unchanged.
- The solver is on when `SOLVER_API_KEY` is set. `SOLVER_PROFILES` is removed and ignored if present. `SOLVER_MAX_PER_HOUR` defaults to 100.
- Guard: reCAPTCHA v2 only, judged on the first `g-recaptcha` element. Allowed inside the form: hidden inputs, submit/button/image/reset inputs, and the `g-recaptcha-response` textarea. Any other input, textarea, select, checkbox or radio makes it a content form. A widget outside any `<form>` is content.
- hCaptcha and Amazon's `captchacharacters` stay unconditional blocks.
- 423 body: `{ blocked, profile, host, reason, marker, html, capture }`; `capture` omitted if the write failed. The `paused` 423 has no `html`. `Retry-After` stays on `paused`.
- `marker` comes from this fixed list: `captcha_widget:g-recaptcha`, `captcha_widget:h-captcha`, `captcha_widget:amazon`, `google_sorry`, `interruption_page`, `verify_human`, `ebay_challenge_redirect`, `ebay_error_page`, `http_block_status`.
- Run tests with `pnpm exec vitest run --reporter=verbose --pool=forks`. Gate before each commit: `pnpm exec tsc --noEmit && pnpm exec biome check src test`.
- Tests assert behavior through public functions, never by grepping source.

## Review Focus

- A signup form with a text input and a reCAPTCHA must never be solved or blocked (Task 1, Task 3).
- A reCAPTCHA widget outside any form, and Mercari's hidden-textarea page, return 200 (Task 1).
- A block on one unknown host must not pause or slow another unknown host (Task 2, Task 3).
- A spent solver budget or a missing sitekey on eBay is an unsolved block and pauses eBay (Task 3).
- With no `SOLVER_API_KEY`, a challenge form returns 423 with `html` and `marker`, and a failing capture write still returns the 423 without `capture` (Task 3).

## Execution rulings

Task 2 also updates the Scheduler call sites in `src/app.ts`, `src/server.ts` and the tests, and Task 3 also removes the `solverProfiles` argument at the `createApp` call in `src/server.ts` (Task 4 removes the config field), so every commit passes the gate.

---

### Task 1: Challenge-form guard and markers in detect.ts

**Files:**
- Modify: `src/detect.ts`
- Test: `test/detect.test.ts`

**Interfaces:**
- Produces: `PageVerdict` blocked variant becomes `{ kind: "blocked"; reason: string; marker: string }`.
- Produces: `export function challengeFormWidget(html: string): string | null` returns the opening tag of the first `g-recaptcha` element when it sits inside a `<form>` whose only fields are the allowed ones, else null. Scripts and styles are ignored as today.
- `detectChallenge(html, finalUrl): Challenge | null` now also requires `challengeFormWidget(html)` non-null. Its sitekey rules are unchanged.
- `hasChallenge(html, finalUrl): boolean` is true for Google `/sorry`, a non-null `challengeFormWidget`, or an unconditional h-captcha or `captchacharacters` marker.
- `classifyPage` blocks a `g-recaptcha` widget only when `challengeFormWidget` is non-null. Markers: reason `captcha` pairs with `captcha_widget:g-recaptcha`, `captcha_widget:h-captcha` or `captcha_widget:amazon`; the other reasons use the marker of the same name (`google_sorry`, `interruption_page`, `verify_human`, `ebay_challenge_redirect`, `ebay_error_page`, `http_block_status`).

- [ ] **Step 1: Write failing tests** in `test/detect.test.ts`:
  - `blocks a reCAPTCHA challenge form` (form with hidden inputs, the widget div and a submit button) expects `{ kind: "blocked", reason: "captcha", marker: "captcha_widget:g-recaptcha" }`.
  - `returns ok for a widget in a form with a text input`, and the same with `email`, `password`, a textarea, a select and a checkbox (parameterized).
  - `returns ok for a widget outside any form`.
  - `judges only the first widget`: a content form first and a challenge form second returns ok.
  - `blocks hCaptcha with marker captcha_widget:h-captcha` and `blocks captchacharacters with marker captcha_widget:amazon`, both unconditional.
  - `detectChallenge returns null for a widget in a content form` and still returns the sitekey for the Google `/sorry` fixture.
  - `hasChallenge` is false for a content-form widget and true for a challenge form.
  - Update existing tests that expect a bare `<div class="g-recaptcha"></div>` to block so they wrap it in a challenge form, and extend the blocked expectations with `marker`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/detect.test.ts --reporter=verbose --pool=forks`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the interfaces above in `src/detect.ts`. Extract `<form>...</form>` blocks from the script-stripped markup (browser-serialized HTML is well formed), find the first `g-recaptcha` tag with the existing lookaround regex, and judge the form that contains it. Thread `marker` through `blockReason` and `classifyPage`.
- [ ] **Step 4: Run** the full suite and the gate. Expected: PASS (fix call sites in `app.ts` and `browser.ts` that build or read blocked verdicts only if the type check fails).
- [ ] **Step 5: Commit** `feat(detect): judge reCAPTCHA by challenge form and report the matched marker`.

### Task 2: Scheduler keyed by string, pause policy on the profile

**Files:**
- Modify: `src/profiles.ts`, `src/throttle.ts`
- Test: `test/profiles.test.ts`, `test/throttle.test.ts`

**Interfaces:**
- Produces: `Profile` gains `pauseOnBlock: boolean` (`ebay` and `reddit` true, `google` and `anon` false).
- Produces: `export function scheduleKey(url: URL): string` returns the matched profile name, or for `anon` the lowercased hostname with any trailing dot removed.
- Produces: `class Scheduler { constructor(clock: SchedulerClock, opts?: { maxQueue?: number; blockPauseMs?: number }); run<T>(key: string, minGapMs: readonly [number, number], task: () => Promise<T>): Promise<T>; pause(key: string): void; pausedUntil(key: string): number | undefined }`.
- Produces: `ProfilePausedError(key: string, until: number)` with fields `key` and `until`.

- [ ] **Step 1: Write failing tests.** `profiles.test.ts`: `scheduleKey maps ebay subdomains to ebay`, `scheduleKey uses the hostname for unknown hosts`, `pauseOnBlock is true only for ebay and reddit`. `throttle.test.ts` (adapt existing cases to the new signatures): `two keys do not share a gap`, `pausing one key leaves another runnable`, plus the existing gap, queue and pause cases.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** The scheduler keeps its single browser slot and queue; only the maps and the gap lookup change.
- [ ] **Step 4: Run** the files, then the gate. `app.ts` will not type check until Task 3; run tsc after Task 3 and keep this task's commit to the files above.
- [ ] **Step 5: Commit** `feat(profiles): schedule per key and mark which profiles pause on a block`.

### Task 3: Richer 423, pause rule and solver wiring in app.ts

**Files:**
- Modify: `src/app.ts`, `src/state-store.ts`
- Test: `test/app.test.ts`, `test/state-store.test.ts`

**Interfaces:**
- Consumes: `scheduleKey`, `PROFILES[...].minGapMs`, `PROFILES[...].pauseOnBlock`, `Scheduler` and `ProfilePausedError` from Task 2; blocked `marker` from Task 1.
- Produces: `StateStore.saveCapture(profile, kind, html): Promise<string>` resolving to the saved filename (no directory).
- `AppDeps` loses `solverProfiles`. The fetcher receives `deps.solver` for every profile.
- The task pauses only when the verdict is blocked and `pauseOnBlock` is true, calling `scheduler.pause(key)` before it frees its slot.
- Blocked response: `{ blocked: true, profile, host, reason, marker, html, capture? }`, status 423.
- The `done` log line adds `entry` (the profile name), `marker`, `challengeType` (`"recaptcha_v2"` when a solve ran) and `attempts` (1 when a solve ran).

- [ ] **Step 1: Write failing tests** in `test/app.test.ts` with the existing stub fetcher and scheduler helpers:
  - `423 body carries host, marker, html and capture`.
  - `omits capture when the capture write fails` (store stub rejects) and still returns 423.
  - `an unsolved challenge on anon returns 423 and does not pause the host` (second request reaches the fetcher).
  - `an unsolved challenge on ebay pauses ebay` (second request gets `reason: "paused"` with `Retry-After` and no `html`).
  - `a block on one unknown host does not pause another unknown host`.
  - `passes the solver to the fetcher for every profile`, and `a signup form with a widget returns 200` (the stub fetcher returns that HTML; the classifier decides).
  - `with a spent budget on ebay the challenge stays unsolved and blocks and pauses` (stub fetcher returns `solve: "failed", solveReason: "budget_exceeded"` with the challenge-form HTML).
  - `state-store.test.ts`: `saveCapture resolves to the file name`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. Keep the existing 401, 429, 500 and 502 paths unchanged.
- [ ] **Step 4: Run** the full suite and the gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(app): return html and marker on a block and pause only eBay and Reddit`.

### Task 4: Config and deploy manifest

**Files:**
- Modify: `src/config.ts`, `src/server.ts`, `deploy/k8s/gateway-deployment.yaml`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `Config` loses `solverProfiles`. `SOLVER_MAX_PER_HOUR` defaults to 100. An environment containing `SOLVER_PROFILES` loads without error and the value is ignored.

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`: `defaults the solver budget to 100 per hour`, `ignores SOLVER_PROFILES`, `has no solverProfiles in the loaded config`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the `SOLVER_PROFILES` schema, the `solverProfiles` field and its wiring in `src/server.ts`. Remove the `SOLVER_PROFILES` env entry from the manifest and set `SOLVER_MAX_PER_HOUR` to `"100"` there.
- [ ] **Step 4: Run** the full suite and the gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(config): solve on every host and raise the budget to 100 per hour`.

### Task 5: Documentation and version

**Files:**
- Modify: `README.md`, `package.json`, `deploy/k8s/gateway-deployment.yaml`

- [ ] **Step 1: README.** Add a Configuration section: a table of `GATEWAY_TOKEN`, `CAMOUFOX_WS_URL`, `STATE_DIR`, `PORT`, `LOG_LEVEL`, `SOLVER_API_KEY`, `SOLVER_BASE_URL`, `SOLVER_MAX_PER_HOUR` with default and effect, and the host table from the spec. Replace the Solver section's `SOLVER_PROFILES` text with the always-on rule and the challenge-form guard. Document the 423 body fields and the marker list, and note that callers feeding an LLM should extract with `jq` instead of printing `html`. Run the `no-ai-slop` skill then the `humanizer` skill on the new prose before saving.
- [ ] **Step 2: Version.** Bump `package.json` to `0.3.0` and the manifest image tag to `0.3.0`.
- [ ] **Step 3: Gate.** Run the full suite and the gate. Expected: PASS.
- [ ] **Step 4: Follow-up beads.** `bd create` one issue each for updating the 423 handling in the `ai-listings` reprice command and in `agent-skills` `web-research/references/stealth-browser.md`. Record the returned IDs in the commit body.
- [ ] **Step 5: Commit** `docs: document configuration, the 423 body and the host table; release 0.3.0`.

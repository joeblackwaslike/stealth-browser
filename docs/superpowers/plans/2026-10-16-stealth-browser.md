# stealth-browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Pi cluster's Browserless with a TypeScript gateway in front of one Camoufox server, with per-site saved logins, throttling, and explicit block and session-expired errors.

**Architecture:** A Hono gateway (`POST /content`, Browserless-compatible) picks a profile from the URL host, waits for that profile's throttle slot, opens a fresh Playwright context on a remote Camoufox server with the profile's saved `storageState`, and classifies the page before returning it. Logins are captured by hand on the operator's Mac with a Python Camoufox script that uses the same pinned fingerprint, then uploaded to the gateway, which keeps them on a Longhorn PVC.

**Tech Stack:** TypeScript (Node 22, pnpm, ESM, Hono + `@hono/node-server`, Zod, `@t3-oss/env-core`, pino, Vitest, Biome, `playwright-core`), Python 3.14 (`cloverlabs-camoufox`, run via `uv`), k3s on ARM64 Pi 5, Longhorn, Tailscale ingress, GHCR.

**Spec:** `docs/superpowers/specs/2026-10-16-stealth-browser-design.md`

## Global Constraints

- Node.js 22+, `pnpm`, ESM only, TypeScript strict with `noUncheckedIndexedAccess: true`, Biome, no `any`, Zod at every boundary (env, request bodies, uploaded state).
- Playwright versions must match exactly: Camoufox image `playwright==1.59.0`; gateway `playwright-core@1.59.0` (pinned, no caret).
- Camoufox: `cloverlabs-camoufox[geoip]==0.6.0`, browser `150.0.2`, ARM64 build `alpha.25` (AMD64 `alpha.26`).
- Images are `linux/arm64`, pushed to GHCR with exact version tags, never `:latest`.
- No proxy. All traffic leaves from the home IP.
- Profiles and starting gaps: `ebay` 20 000–40 000 ms jittered; `reddit` 5 000–10 000 ms; `anon` 3 000–8 000 ms.
- Concurrency 1 across the whole browser. Queue holds 5 waiting requests; the 6th gets 429.
- After a block, the profile pauses for 30 minutes (`1_800_000` ms) and answers 423 until the pause ends.
- Response bodies: 423 `{ blocked: true, profile, reason }`; 401 `{ session_expired: true, profile }`; 429 `{ error: "queue_full" }`.
- Every route requires the bearer token (k8s probes use `tcpSocket`).
- Namespace `stealth-browser`; Tailscale hostname `stealth-browser`; secret-manager items `stealth-browser - gateway token`, `stealth-browser - ws path`, `stealth-browser - ebay session`, `stealth-browser - reddit session`.
- Nothing secret in git. Never log `storageState` contents or the ws path.

## Review Focus

1. A normal page whose scripts contain the word "captcha" (Amazon and Reddit bundles do) must classify as `ok`, not `blocked`. Test in Task 3.
2. A request for `ebay` or `reddit` while that profile has no saved state must return 401 `session_expired` without navigating. Test in Task 6.
3. A login uploaded with `PUT /profiles/:name/state` while a scrape for the same profile is in flight must survive; the scrape's cookie write-back must not overwrite it. Tests in Tasks 5 and 6.
4. A URL pointing at localhost, a private IP, `*.svc`, `*.cluster.local`, `*.local`, or a non-http(s) scheme must return 400. The Camoufox pod runs inside the cluster and would otherwise fetch internal services. Test in Task 2.
5. After the Camoufox pod restarts, the next request must reconnect instead of failing with 502 forever. Test in Task 8.

---

## File Structure

```
src/config.ts        env schema (t3-env)
src/profiles.ts      profile table, host routing
src/url-guard.ts     public http(s) URL check
src/detect.ts        page classification (ok / blocked / session_expired)
src/throttle.ts      Scheduler: global concurrency 1, per-profile gaps, queue cap, block pause
src/state-store.ts   per-profile storageState on disk with generation-guarded write-back; captures
src/browser.ts       Camoufox fetcher (playwright-core firefox.connect)
src/app.ts           Hono routes
src/server.ts        entry point and wiring
test/**              Vitest unit tests; test/fixtures/*.html
test/integration/**  tests against a local Camoufox container
camoufox/            Dockerfile, launch_server.py, NOTICE
profiles/fingerprint.json
scripts/gen_fingerprint.py, scripts/login.py, scripts/smoke.ts, scripts/build.sh
deploy/k8s/*.yaml, deploy/k8s/kustomization.yaml, deploy/deploy.sh
Dockerfile           gateway image
```

---

### Task 1: Scaffold and config

**Files:**
- Create: project scaffold via `spinup-ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: Record<string, string | undefined>): Config` where `type Config = { gatewayToken: string; camoufoxWsUrl: string; stateDir: string; port: number; logLevel: "debug" | "info" | "warn" | "error" }`. Env names: `GATEWAY_TOKEN` (min 32 chars), `CAMOUFOX_WS_URL` (must start `ws://` or `wss://`), `STATE_DIR` (default `/state`), `PORT` (default `8080`), `LOG_LEVEL` (default `info`).

- [ ] **Step 1: Scaffold.** Invoke the `spinup-ts:spinup-ts` skill and retrofit this worktree (`pnpm dlx spinup-ts update .`). Package name `stealth-browser`, Node service (not library), Vercel deploy off, Docker on. Add deps: `hono`, `@hono/node-server`, `zod`, `@t3-oss/env-core`, `pino`, and `playwright-core@1.59.0` pinned exactly.
- [ ] **Step 2: Write the failing test** `test/config.test.ts`:
  - `rejects a gateway token shorter than 32 characters` → `expect(() => loadConfig({ GATEWAY_TOKEN: "short", CAMOUFOX_WS_URL: "ws://x:3000/p" })).toThrow()`
  - `rejects a non-websocket camoufox url` → `CAMOUFOX_WS_URL: "http://x"` throws
  - `applies defaults` → with a 32-char token and `ws://camoufox:3000/abc`, expect `{ stateDir: "/state", port: 8080, logLevel: "info" }` to be contained in the result
- [ ] **Step 3: Run** `pnpm vitest run test/config.test.ts`. Expected: FAIL, `loadConfig` not found.
- [ ] **Step 4: Implement `loadConfig`** in `src/config.ts` with `createEnv` from `@t3-oss/env-core`, `runtimeEnv: env`, mapping to camelCase keys.
- [ ] **Step 5: Run** `pnpm vitest run test/config.test.ts` and `pnpm biome check . && pnpm tsc --noEmit`. Expected: PASS, clean.
- [ ] **Step 6: Commit** `git add -A && git commit -m "chore: scaffold gateway and env config"`

### Task 2: Profiles and URL guard

**Files:**
- Create: `src/profiles.ts`, `src/url-guard.ts`
- Test: `test/profiles.test.ts`, `test/url-guard.test.ts`

**Interfaces:**
- Produces:
  - `type ProfileName = "ebay" | "reddit" | "anon"`; `type LoginProfileName = Exclude<ProfileName, "anon">`
  - `type Profile = { name: ProfileName; hosts: readonly string[]; minGapMs: readonly [number, number]; requiresLogin: boolean }`
  - `const PROFILES: Readonly<Record<ProfileName, Profile>>` with hosts `ebay: ["ebay.com", "www.ebay.com"]`, `reddit: ["reddit.com", "old.reddit.com", "www.reddit.com"]`, `anon: []`, gaps from Global Constraints, `requiresLogin` true for `ebay` and `reddit`.
  - `profileForUrl(url: URL): ProfileName` (exact host match, no suffix matching, else `"anon"`)
  - `isProfileName(value: string): value is ProfileName`; `isLoginProfile(value: string): value is LoginProfileName`
  - `isPublicHttpUrl(url: URL): boolean`

- [ ] **Step 1: Write failing tests.**
  - `profileForUrl`: `https://www.ebay.com/sch/i.html` → `"ebay"`; `https://old.reddit.com/r/x` → `"reddit"`; `https://www.amazon.com/s?k=x` → `"anon"`; `https://signin.ebay.com/` → `"anon"` (exact match only); `https://WWW.EBAY.COM/` → `"ebay"` (URL lowercases hosts).
  - `isPublicHttpUrl` false for: `http://localhost:3000`, `http://127.0.0.1`, `http://10.1.2.3`, `http://192.168.1.1`, `http://172.16.0.1`, `http://169.254.169.254`, `http://[::1]/`, `http://browserless.ai-listings.svc.cluster.local:3000`, `http://camoufox.svc/`, `http://printer.local/`, `file:///etc/passwd`, `ftp://example.com`. True for `https://www.ebay.com/` and `http://example.com/`.
- [ ] **Step 2: Run** `pnpm vitest run test/profiles.test.ts test/url-guard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. `isPublicHttpUrl` checks the scheme, the literal host against private and loopback IPv4/IPv6 ranges with `node:net` `isIP`, and the host suffixes `.svc`, `.cluster.local`, `.local`, plus `localhost`. Mark the ceiling with `// ponytail: literal-host check only; DNS names resolving to private IPs pass. Add resolve-then-check if callers ever stop being the operator's own agents.`
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: profile routing and public URL guard"`

### Task 3: Page classification

**Files:**
- Create: `src/detect.ts`, `test/fixtures/ebay-challenge.html`, `test/fixtures/ebay-sold-ok.html`, `test/fixtures/amazon-search-ok.html`, `test/fixtures/reddit-login-wall.html`
- Test: `test/detect.test.ts`

**Interfaces:**
- Consumes: `ProfileName` (Task 2)
- Produces: `type PageVerdict = { kind: "ok" } | { kind: "blocked"; reason: string } | { kind: "session_expired" }` and `classifyPage(input: { profile: ProfileName; html: string; finalUrl: string; cookieNames: readonly string[] }): PageVerdict`

Rules, checked in this order:
1. Blocked if `finalUrl` path contains `/splashui/challenge` (reason `"ebay_challenge_redirect"`), or the `<title>` matches `/Pardon Our Interruption/i` (reason `"interruption_page"`), or the HTML contains a captcha widget (`class="g-recaptcha"`, `class="h-captcha"`, `id="captchacharacters"` on Amazon) or "verify you are human" in visible text. Reason `"captcha"` or `"verify_human"`. The word "captcha" anywhere else is not a block.
2. Session expired if profile is `ebay` and the `finalUrl` host is `signin.ebay.com`; or profile is `reddit` and (`finalUrl` path starts with `/login` or `cookieNames` lacks `reddit_session`).
3. Otherwise `ok`. Profile `anon` is never `session_expired`.

Synthetic fixtures are minimal HTML built around these markers. Task 12 replaces them with captured pages.

- [ ] **Step 1: Write failing tests**, one per rule plus:
  - `treats a page whose script mentions captcha as ok` → `amazon-search-ok.html` contains `<script>var captchaConfig = {}</script>` and product markup; expect `{ kind: "ok" }` for `anon`.
  - `checks blocks before session expiry` → reddit profile, challenge title, no `reddit_session` cookie → `blocked`.
  - `never reports session_expired for anon` → `finalUrl: "https://signin.ebay.com/"`, profile `anon` → `ok`.
- [ ] **Step 2: Run** `pnpm vitest run test/detect.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `classifyPage`.** Title extracted with a regex on `<title>`. Visible-text check strips `<script>` and `<style>` blocks first.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: classify blocked and session-expired pages`.

### Task 4: Scheduler

**Files:**
- Create: `src/throttle.ts`
- Test: `test/throttle.test.ts`

**Interfaces:**
- Consumes: `ProfileName`, `Profile`, `PROFILES` (Task 2)
- Produces:
  - `type SchedulerClock = { now: () => number; sleep: (ms: number) => Promise<void>; random: () => number }`
  - `class Scheduler { constructor(profiles: Readonly<Record<ProfileName, Profile>>, clock: SchedulerClock, opts?: { maxQueue?: number; blockPauseMs?: number }); run<T>(profile: ProfileName, task: () => Promise<T>): Promise<T>; pause(profile: ProfileName): void; pausedUntil(profile: ProfileName): number | undefined }`
  - `class QueueFullError extends Error`; `class ProfilePausedError extends Error { readonly profile: ProfileName; readonly until: number }`
  - Defaults `maxQueue = 5`, `blockPauseMs = 1_800_000`.

Behavior: tasks run one at a time in FIFO order across all profiles. Before starting a task, wait until `lastStart[profile] + gap`, where `gap = min + random() * (max - min)`, drawn per task. A task that throws still releases the slot. `run` rejects with `QueueFullError` when 5 tasks are already waiting (the running one doesn't count). It rejects with `ProfilePausedError` at enqueue time if the profile is paused, and at start time if a pause began while the task waited.

- [ ] **Step 1: Write failing tests** using a fake clock (`now` returns a counter that `sleep` advances; `random` returns a fixed value):
  - `runs one task at a time` (two tasks; the second starts only after the first resolves)
  - `waits the per-profile gap between starts` (two `ebay` tasks with `random = 0.5` → second starts 30 000 ms after the first)
  - `does not delay a different profile by another profile's gap` (`ebay` then `anon` → `anon` starts with no gap wait)
  - `rejects the sixth waiting task with QueueFullError`
  - `rejects with ProfilePausedError during a pause and accepts again after 1_800_000 ms`
  - `rejects a queued task when its profile is paused before it starts`
  - `releases the slot when a task throws`
- [ ] **Step 2: Run** `pnpm vitest run test/throttle.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `Scheduler`** with a promise chain for the single slot and a waiting counter.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: single-slot scheduler with per-profile gaps and block pause`.

### Task 5: State store and captures

**Files:**
- Create: `src/state-store.ts`
- Test: `test/state-store.test.ts`

**Interfaces:**
- Consumes: `ProfileName`, `LoginProfileName` (Task 2)
- Produces:
  - `type StorageState = Awaited<ReturnType<import("playwright-core").BrowserContext["storageState"]>>`
  - `const storageStateSchema: z.ZodType<StorageState>` (`cookies` array of `{ name, value, domain, path, expires, httpOnly, secure, sameSite: "Strict" | "Lax" | "None" }`, `origins` array of `{ origin, localStorage: { name, value }[] }`)
  - `type StoredState = { state: StorageState; generation: number }`
  - `type StateStore = { read(profile: LoginProfileName): Promise<StoredState | undefined>; write(profile: LoginProfileName, state: StorageState): Promise<number>; writeIfUnchanged(profile: LoginProfileName, state: StorageState, expectedGeneration: number): Promise<boolean>; saveCapture(profile: ProfileName, kind: "blocked" | "session_expired", html: string): Promise<void> }`
  - `createStateStore(dir: string, now?: () => Date): StateStore`

Files: `<dir>/<profile>.json` (mode `0o600`), written to a temp file and then renamed. Generations are in-memory per profile and start at 0 for a file that exists at boot (`// ponytail: in-memory generation, fine for replicas: 1`). `write` always writes and bumps the generation. `writeIfUnchanged` writes only when the current generation equals `expectedGeneration`. Captures go to `<dir>/captures/<profile>-<kind>-<ISO timestamp>.html`, keeping the newest 20.

- [ ] **Step 1: Write failing tests** (tmp dir via `fs.mkdtemp`):
  - `returns undefined for a profile with no file`
  - `round-trips a written state and bumps the generation`
  - `writeIfUnchanged refuses a stale generation` → read (gen 1), `write` new state (gen 2), `writeIfUnchanged(old, 1)` returns false, and `read` returns the newer state
  - `throws a clear error on a corrupt state file` → write `"{not json"` to `ebay.json`; `read("ebay")` rejects with a message containing `ebay.json`
  - `writes state files with mode 0o600`
  - `keeps only the newest 20 captures`
  - `storageStateSchema rejects a body without cookies`
- [ ] **Step 2: Run** `pnpm vitest run test/state-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/state-store.ts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: on-disk login state with generation-guarded write-back`.

### Task 6: HTTP routes

**Files:**
- Create: `src/app.ts`
- Test: `test/app.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; `Fetcher` type from Task 8, defined here first so Task 8 implements it: `type FetchRequest = { url: string; waitForTimeout: number; storageState?: StorageState }`, `type FetchResult = { html: string; finalUrl: string; status: number | null; storageState: StorageState }`, `type Fetcher = (req: FetchRequest) => Promise<FetchResult>`. Put these types in `src/browser.ts` now, with no implementation yet.
- Produces: `createApp(deps: { token: string; fetcher: Fetcher; scheduler: Scheduler; store: StateStore; logger: import("pino").Logger }): Hono`

Routes (all behind `bearerAuth({ token })` from `hono/bearer-auth`):
- `GET /healthz` → 200 `{ ok: true }`.
- `POST /content`, body `{ url: string; waitForTimeout?: number (int, 0–15000, default 3000); profile?: ProfileName }`.
  1. Invalid body or `!isPublicHttpUrl` → 400 `{ error: "invalid_request", message }`.
  2. Profile = `body.profile ?? profileForUrl(url)`.
  3. Login profile with no stored state → 401 `{ session_expired: true, profile }`, no navigation.
  4. `scheduler.run(profile, () => fetcher({ url, waitForTimeout, storageState }))`.
  5. `classifyPage` with the cookie names from `result.storageState`. On `blocked`: `scheduler.pause(profile)`, `store.saveCapture`, then 423 `{ blocked: true, profile, reason }`. On `session_expired`: `saveCapture`, then 401. On `ok`: for login profiles `store.writeIfUnchanged(profile, result.storageState, generationReadInStep3)`. Return 200, `content-type: text/html; charset=utf-8`, with header `X-Final-Url`.
  6. `QueueFullError` → 429 `{ error: "queue_full" }`. `ProfilePausedError` → 423 `{ blocked: true, profile, reason: "paused" }` with a `Retry-After` header in seconds. Any other fetcher error → 502 `{ error: "navigation_failed", message }`.
- `PUT /profiles/:name/state`: `:name` not a login profile → 404. Body fails `storageStateSchema` → 400. Otherwise `store.write`, then 204.
- Log one line per request: `{ profile, host, verdict, status, ms }`. Never log state or tokens.

- [ ] **Step 1: Write failing tests** with `app.request()`, a fake `Fetcher`, a real `Scheduler` with a zero-gap fake clock, and a real store in a tmp dir:
  - `rejects requests without the bearer token` (401 from middleware on `/healthz`)
  - `returns html and X-Final-Url for an ok anon page`
  - `returns 401 session_expired for ebay with no saved state and never calls the fetcher`
  - `returns 423 and pauses the profile when the page is a challenge`, and a second request returns 423 `reason: "paused"` without calling the fetcher
  - `returns 400 for a cluster-internal url` (`http://camoufox.stealth-browser.svc.cluster.local:3000`)
  - `returns 400 for waitForTimeout above 15000`
  - `returns 429 when the queue is full`
  - `keeps a login uploaded mid-scrape` → seed `reddit` state A; the fake fetcher blocks on a deferred promise; while it's pending, `PUT /profiles/reddit/state` with state B; release the fetcher with cookies from state A plus `reddit_session`; expect the store to hold B
  - `PUT rejects the anon profile with 404 and a malformed body with 400`
- [ ] **Step 2: Run** `pnpm vitest run test/app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `createApp`.**
- [ ] **Step 4: Run** `pnpm vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: content and profile-state routes`.

### Task 7: Camoufox image and pinned fingerprint

**Files:**
- Create: `camoufox/Dockerfile`, `camoufox/launch_server.py`, `camoufox/NOTICE`, `scripts/gen_fingerprint.py`, `profiles/fingerprint.json`

**Interfaces:**
- Produces: image `ghcr.io/joeblackwaslike/stealth-browser-camoufox:150.0.2-1`, which listens on `PORT` (default 3000) at `ws://<host>:<PORT>/<WS_PATH>` and reads the fingerprint from `FINGERPRINT_PATH` (default `/etc/camoufox/fingerprint.json`). Also `profiles/fingerprint.json`, a flat Camoufox config dict.

- [ ] **Step 1: Start from rjocoleman/camoufox-server.** Copy its `Dockerfile` and `launch-server.py` (MIT) into `camoufox/`, keep its version args (Global Constraints), its Playwright pin, and its sync-bug patch. Put its license text in `camoufox/NOTICE`. Add `xvfb` to the apt install so `headless="virtual"` works.
- [ ] **Step 2: Write `scripts/gen_fingerprint.py`** with uv inline metadata pinning `cloverlabs-camoufox[geoip]==0.6.0` and `playwright==1.59.0`. It calls `camoufox.utils.launch_options(os="macos", headless=False)`, decodes the Camoufox config from the returned env (`CAMOU_CONFIG` or its numbered chunks; confirm the key names against the installed version), drops geo keys (`timezone`, `locale:*`, `geolocation:*`, `webrtc:*`) because `geoip=True` sets those at launch, and writes `profiles/fingerprint.json` sorted and pretty-printed. Run it once with `uv run scripts/gen_fingerprint.py` and commit the output.
- [ ] **Step 3: Write `camoufox/launch_server.py`.** It loads the JSON at `FINGERPRINT_PATH` and calls `launch_server(headless="virtual", geoip=True, os="macos", config=fingerprint, port=int(PORT), ws_path=WS_PATH)`. It exits non-zero with a clear message if `WS_PATH` is unset or shorter than 32 characters.
- [ ] **Step 4: Build and run locally on the M1** (arm64 native): `docker build -t sb-camoufox:dev camoufox/` and then `docker run --rm -p 3000:3000 -e WS_PATH=$(openssl rand -hex 24) -v $PWD/profiles/fingerprint.json:/etc/camoufox/fingerprint.json:ro sb-camoufox:dev`. Expected: the log shows the ws endpoint.
- [ ] **Step 5: Verify the fingerprint is pinned.** A throwaway `tsx` snippet connects twice with `playwright-core` `firefox.connect` and reads `navigator.userAgent`, `screen.width`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, and `navigator.webdriver`. Expected: identical UA and screen across both connections and across a container restart, timezone `America/New_York`, webdriver `false`.
- [ ] **Step 6: Commit** `feat: camoufox server image with pinned fingerprint`.

### Task 8: Camoufox fetcher and server entry

**Files:**
- Modify: `src/browser.ts` (types from Task 6)
- Create: `src/server.ts`, `Dockerfile`, `test/integration/browser.test.ts`, `vitest.integration.config.ts`

**Interfaces:**
- Consumes: `Fetcher` types (Task 6), `loadConfig` (Task 1), `createApp` (Task 6), `Scheduler` (Task 4), `createStateStore` (Task 5)
- Produces: `createCamoufoxFetcher(wsEndpoint: string): { fetch: Fetcher; close(): Promise<void> }`; `pnpm test:integration` script; image `ghcr.io/joeblackwaslike/stealth-browser-gateway:<package.json version>`

Fetcher behavior: lazily `firefox.connect(wsEndpoint)`. Reconnect when the browser is disconnected (`browser.isConnected()` false or the `disconnected` event fired). Per request: `newContext({ storageState })`, route-abort `image`, `media` and `font` resource types, `goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })`, `waitForTimeout`, then read `content()`, `page.url()`, the response status and `context.storageState()`. Close the context in `finally`.

- [ ] **Step 1: Write failing integration tests** that need the Task 7 container running (`CAMOUFOX_WS_URL` env, skipped with a message when unset):
  - `fetches a page and returns final url and html` (`https://example.com/` → html contains `Example Domain`)
  - `returns cookies the page set` (`https://httpbin.org/cookies/set?sb=1` → `result.storageState.cookies` includes a cookie named `sb`)
  - `reconnects after the camoufox server restarts` → fetch, `docker restart` the container (test helper via `node:child_process` `execFileSync`), fetch again → succeeds
- [ ] **Step 2: Run** `pnpm test:integration`. Expected: FAIL (`createCamoufoxFetcher` missing).
- [ ] **Step 3: Implement** `createCamoufoxFetcher`, plus `src/server.ts` (config → pino → store → scheduler with real clock → fetcher → `createApp` → `serve`, closing the fetcher on SIGTERM).
- [ ] **Step 4: Run** `pnpm test:integration` and `pnpm vitest run`. Expected: PASS.
- [ ] **Step 5: Write the gateway `Dockerfile`** (multi-stage, `node:22-slim`, `pnpm install --frozen-lockfile --prod`, `tsc` build, non-root user, `CMD ["node", "dist/server.js"]`). Smoke it locally against the Task 7 container: `curl -H "Authorization: Bearer $T" -d '{"url":"https://example.com"}' localhost:8080/content` returns HTML.
- [ ] **Step 6: Commit** `feat: camoufox fetcher, server entry, gateway image`.

### Task 9: Build, manifests, deploy

**Files:**
- Create: `scripts/build.sh`, `deploy/k8s/{namespace,pvc,camoufox-deployment,camoufox-service,gateway-deployment,gateway-service,ingress,kustomization}.yaml`, `deploy/deploy.sh`

**Interfaces:**
- Consumes: both images; `profiles/fingerprint.json`
- Produces: a running gateway at `https://stealth-browser.<tailnet>.ts.net`

- [ ] **Step 1: `scripts/build.sh`** runs `docker buildx build --platform linux/arm64 --push` for both images with exact tags (camoufox `150.0.2-<n>`, gateway = `package.json` version). It refuses to run with a dirty tree.
- [ ] **Step 2: Manifests.**
  - `kustomization.yaml` uses a `configMapGenerator` for `camoufox-fingerprint` from `../../profiles/fingerprint.json`.
  - Camoufox: `replicas: 1`, `Recreate`, memory limit `1536Mi`, `WS_PATH` from Secret `stealth-browser-secrets` key `wsPath`, fingerprint mounted at `/etc/camoufox/fingerprint.json`, `tcpSocket` probes on 3000, ClusterIP Service `camoufox`.
  - Gateway: `replicas: 1`, `Recreate` (RWO PVC), memory limit `256Mi`, env `GATEWAY_TOKEN` from the Secret's `gatewayToken`, `WS_PATH` from `wsPath`, and `CAMOUFOX_WS_URL=ws://camoufox.stealth-browser.svc.cluster.local:3000/$(WS_PATH)`. PVC `stealth-browser-state` (longhorn, 1Gi, RWO) mounted at `/state`. `tcpSocket` probes on 8080. ClusterIP Service `gateway`.
  - Both use `imagePullSecrets: [{ name: ghcr-credentials }]`.
  - Ingress copies `ai-listings/deployment/kubernetes/browserless/ingress.yaml` (Tailscale `proxy-group: cluster-ingress`, `defaultBackend` because ProxyGroup ingress does not support `rules.host`) with hostname `stealth-browser`, backend `gateway:8080`.
- [ ] **Step 3: `deploy/deploy.sh`.**
  1. One batched secret-manager call reads the token and ws path from the two items.
  2. Create the namespace, the `ghcr-credentials` docker-registry secret from `$GHCR_TOKEN` (same pattern as `ai-listings/deployment/scripts/deploy-app.sh:83`), and `stealth-browser-secrets`, all via `--dry-run=client -o yaml | kubectl apply -f -`.
  3. `kubectl apply -k deploy/k8s` and wait for rollout.
  4. For each login profile, `kubectl exec deploy/gateway -- test -f /state/<p>.json`. Only when the file is missing, fetch the `stealth-browser - <p> session` backup from the secret manager and `PUT` it to the gateway. It never overwrites an existing file.

  Create the two secret-manager items first if missing (random 48-char token and ws path).
- [ ] **Step 4: Validate** with `kubectl apply -k deploy/k8s --dry-run=server`. Expected: no errors.
- [ ] **Step 5: Deploy** with `scripts/build.sh && deploy/deploy.sh`. Expected: both pods `Running`, and `curl -H "Authorization: Bearer $T" https://stealth-browser.<tailnet>.ts.net/healthz` returns `{"ok":true}`.
- [ ] **Step 6: Commit** `feat: k8s manifests, build and deploy scripts`.

### Task 10: Login CLI

**Files:**
- Create: `scripts/login.py`; Modify: `package.json` (`"login": "uv run scripts/login.py"`)

**Interfaces:**
- Consumes: `profiles/fingerprint.json`, `PUT /profiles/:name/state` (Task 6)
- Produces: `pnpm signin <ebay|reddit> [--signup]`

Behavior: read `STEALTH_BROWSER_URL` and `STEALTH_BROWSER_TOKEN`, falling back to `BROWSERLESS_URL` and `BROWSERLESS_TOKEN` (no secret-manager call for the token). Launch `Camoufox(headless=False, os="macos", config=fingerprint, geoip=True)`, then open the sign-in URL: ebay `https://signin.ebay.com/`, ebay `--signup` `https://signup.ebay.com/pa/crte`, reddit `https://www.reddit.com/login/`. Wait for Enter. Take `context.storage_state()` and refuse to upload if a reddit state lacks a `reddit_session` cookie. `PUT` it, then save a backup to the secret manager titled `stealth-browser - <profile> session` (create it, or update it if it exists) from a `0o600` temp file that's deleted afterwards.

- [ ] **Step 1: Write the script** with uv inline metadata pins matching Task 7.
- [ ] **Step 2: Verify with Reddit.** Run `pnpm signin reddit`, log in by hand, press Enter. Expected: `PUT` returns 204, `kubectl exec deploy/gateway -- ls -l /state` shows `reddit.json` with mode `-rw-------`, and the secret-manager backup exists.
- [ ] **Step 3: Verify** `curl` `POST /content` for `https://old.reddit.com/prefs/` returns 200, and its HTML contains the Reddit username.
- [ ] **Step 4: Commit** `feat: hand-login CLI that uploads saved sessions`.

### Task 11: eBay scraping account (manual, operator)

Nothing to build. This task blocks smoke test 3 in Task 12.

- [ ] Run `pnpm signin ebay --signup`. In that window, create a dedicated scraping account with a new email, separate from any eBay account the operator cares about.
- [ ] In the same window, open Seller Hub and enable Terapeak research. Confirm that `https://www.ebay.com/sh/research?marketplace=EBAY-US&keywords=thinkpad&tabName=SOLD` shows sold results.
- [ ] Press Enter so the CLI uploads the session. Confirm `/state/ebay.json` exists.

### Task 12: Smoke tests and real fixtures

**Files:**
- Create: `scripts/smoke.ts` (`pnpm smoke`, `pnpm smoke:fingerprint`)
- Modify: `test/fixtures/*.html`, `src/detect.ts`, `test/detect.test.ts`

**Interfaces:**
- Consumes: deployed gateway (`STEALTH_BROWSER_URL`, `STEALTH_BROWSER_TOKEN`), captures from Task 5

- [ ] **Step 1: Write `scripts/smoke.ts`.** It prints PASS or FAIL per check and exits non-zero on any FAIL.
  1. `smoke:fingerprint`: `kubectl port-forward svc/camoufox 3000` → `firefox.connect` → `Intl...timeZone === "America/New_York"` and `navigator.webdriver === false`.
  2. eBay sold search `https://www.ebay.com/sch/i.html?_nkw=thinkpad+t480&LH_Sold=1&LH_Complete=1` → 200, at least 5 matches of `s-item__price|s-card__price`.
  3. Terapeak URL from Task 11 → 200 and `X-Final-Url` host isn't `signin.ebay.com`.
  4. `https://old.reddit.com/prefs/` → 200; `https://old.reddit.com/r/mechmarket/search?q=keychron&restrict_sr=on` → 200 with `search-result` markup.
  5. `https://www.amazon.com/s?k=usb+c+hub+4k+60hz` → 200 with `s-result-item`; the first `/dp/<ASIN>` link from it → 200 with `productTitle`.
- [ ] **Step 2: Run** `pnpm smoke:fingerprint && pnpm smoke`. Expected: all PASS. A 423 means the run produced a real capture under `/state/captures`. Copy it with `kubectl cp`.
- [ ] **Step 3: Replace synthetic fixtures with real ones.** Use captured challenge pages if any appeared, plus OK pages saved from smoke runs (`curl ... > test/fixtures/ebay-sold-ok.html`, same for Amazon). Adjust `classifyPage` markers until `pnpm vitest run test/detect.test.ts` passes on the real fixtures. Keep the "captcha in a script" test green.
- [ ] **Step 4: Verify session expiry by hand.** `kubectl exec deploy/gateway -- mv /state/ebay.json /state/ebay.json.bak`, request the Terapeak URL → 401 `session_expired`, then move the file back.
- [ ] **Step 5: Commit** `test: smoke script and real-page fixtures`.

### Task 13: Cutover (separate repos and PRs, after Task 12 passes)

- [ ] In the operator's shell environment, set `BROWSERLESS_URL=https://stealth-browser.<tailnet>.ts.net` and `BROWSERLESS_TOKEN` to the gateway token.
- [ ] agent-skills PR: `skills/web-research/references/browserless.md`. Add `amazon.com` and `www.amazon.com` to the known-blocking list. Document the `profile` field, `X-Final-Url`, and the 423, 401, 429 and 400 bodies, including what an agent does on each (423: stop and report; 401: tell the operator to run `pnpm signin <profile>` in the stealth-browser checkout; 429: wait and retry once).
- [ ] ai-listings PR:
  - `.claude/commands/reprice.md` handles 423 and 401 as above.
  - `src/lib/pipeline/comps/url-verify.ts:42` reads `BROWSERLESS_URL` from env (no hardcoded in-cluster URL), with its existing test updated.
  - Delete `deployment/kubernetes/browserless/` and `deployment/scripts/deploy-browserless.sh`, and run `kubectl delete deploy,svc,ingress,secret -n ai-listings -l app=browserless` (check the labels first).
- [ ] Run `/reprice` end to end on one real listing. Expected: comps come back through the new gateway.

# stealth-browser: replace Browserless with a Camoufox gateway

> This is the original design from 2026-10-16, kept as a record. Several details
> changed during the build: Camoufox 156 instead of 150, profiles picked from the
> URL's domain and all its subdomains with no `profile` request field, sign-in
> through the cluster's own browser over VNC, and a NetworkPolicy limiting the
> Camoufox pod's traffic. The [README](../../../README.md) describes how it works now.

## Context

The Pi cluster's Browserless (`ai-listings/deployment/kubernetes/browserless/`, stock
`ghcr.io/browserless/chromium:latest`, no stealth, no cookies) now gets bot challenges on eBay
sold search. `business-ideas/.../11-laptop-ram-ddr4-refresh-2026-10.md:12` logged it on
2026-10-09: Browserless on the Pi, other headless browsers, and 130point all got challenged.
Reddit blocks it too. The request started as `agent-harness/docs/_backlog.md:8`.

The service has three jobs, all read-only, low volume, and mostly driven by agents:

- eBay sold comps, including Terapeak's deeper sold history, which needs a signed-in account.
- Reddit threads, including login-walled ones.
- Amazon product search. The operator gives Claude specs, and Claude searches and reads product pages.

Current callers curl `$BROWSERLESS_URL/content`: `ai-listings/.claude/commands/reprice.md:32-41`
and `agent-skills/skills/web-research/references/browserless.md`. `ai-listings/src/lib/pipeline/comps/url-verify.ts:42`
also calls it with the in-cluster URL hardcoded, but nothing calls that code yet (ai-listings-534).

## Decisions the operator made

- The operator logs in by hand once per site in a real stealth browser window. The session is
  saved and reused, and the operator re-runs the login command when it expires. No stored
  passwords, no auto-login.
- eBay uses a dedicated scraping account, kept apart from any eBay account the operator cares
  about, so a ban on it costs nothing. Reddit uses the operator's Reddit account.
- Terapeak is in v1. The operator enables Seller Hub on the scraping account by hand.
- No proxy. All traffic leaves from the home IP, so request volume stays low to keep that IP
  from getting flagged.
- Camoufox (stealth Firefox) replaces headless Chrome.
- New repo with its own namespace on the Pi cluster.

## Goals, non-goals, anti-goals

- Goals: eBay sold search and Terapeak, Reddit (gated threads included), and Amazon search and
  product pages return real content. Existing callers keep working after a URL and token change.
  Blocks and expired sessions come back as explicit errors, never as a 200 with challenge HTML.
- Non-goals: proxies, captcha-solving services, posting or messaging or acting as the operator,
  high-volume scraping, per-site parsers (callers parse HTML as they do today).
- Anti-goals, which count as failure even if everything else works: any request touching an
  eBay account other than the scraping account; credentials committed to git or pasted into chat; request bursts
  that get the home IP flagged. Throttling is the only protection the home IP has.

## Design

New repo `joeblackwaslike/stealth-browser`, namespace `stealth-browser` on the Pi k3s cluster
(ARM64 Pi 5 nodes, Longhorn storage, Tailscale ingress via `proxy-group: cluster-ingress`, same
pattern as `ai-listings/deployment/kubernetes/browserless/ingress.yaml`).

### 1. Profiles

A profile is one saved login (Playwright `storageState`) plus its throttle settings.

| Profile | Login | Hosts | Starting minimum gap between navigations |
| --- | --- | --- | --- |
| `ebay` | eBay scraping account | `ebay.com`, `www.ebay.com` | 20 to 40 s, jittered |
| `reddit` | The operator's Reddit account | `reddit.com`, `old.reddit.com`, `www.reddit.com` | 5 to 10 s |
| `anon` | none | Amazon and everything else | 3 to 8 s |

All profiles share one pinned Camoufox fingerprint, stored as non-secret JSON in
`profiles/fingerprint.json` (generated once, with `os` pinned). The login CLI and the server load
the same fingerprint, so a saved cookie is always replayed from the device that created it.

### 2. Camoufox server, one Deployment

- Our own small image: Python plus the maintained `cloverlabs-camoufox` wrapper. The original
  `camoufox` PyPI package stopped at 0.4.11 (Firefox 135). A roughly 20-line `launch_server.py`
  calls `launch_server(headless="virtual", geoip=True, config=<fingerprint>, port=3000, ws_path=<secret>)`.
  Use [rjocoleman/camoufox-server](https://github.com/rjocoleman/camoufox-server) (MIT,
  amd64 and arm64, browser baked in) as the reference Dockerfile, including its Playwright pin
  and its patch for the upstream sync bug.
- `geoip=True` sets timezone, locale, and WebRTC IP to match the home IP.
- The WebSocket server has no auth, so `ws_path` is a long random secret and the Service is
  ClusterIP only.
- `replicas: 1`, `strategy: Recreate`, memory limit around 1.5Gi.

### 3. Gateway

A small TypeScript HTTP service and the only thing callers talk to. Pick the framework with
`joe-stack-preferences`. It must run the same Playwright version as the Camoufox image, because
a version mismatch breaks `firefox.connect`. Every route requires a bearer token.

`POST /content` takes the Browserless body `{ url, waitForTimeout?, profile? }` and returns
rendered HTML, so curl callers only change URL and token.

1. Pick the profile from `profile`, or from the URL host using the table above.
2. `firefox.connect`, then `newContext({ storageState })`. Block image, media, and font requests.
3. Wait for the profile's throttle slot, navigate, wait, and read the HTML. Write the context's
   updated `storageState` back so rolling cookies such as Reddit's `token_v2` stay fresh. Close
   the context.
4. Check for blocks before returning. Challenge markers ("Pardon Our Interruption", "verify you
   are human", captcha pages, eBay `splashui/challenge` redirects) return HTTP 423
   `{ blocked: true, profile, reason }`. Logged-out markers on a signed-in profile (eBay sign-in
   redirect, Reddit login wall) return HTTP 401 `{ session_expired: true, profile }`, and the
   agent tells the operator to re-run login. Today a challenge page parses as "not sold"; this stops that.
5. After a 423, pause that profile for 30 minutes and answer its requests with 423 until the
   pause ends. Retrying into a challenge from the home IP is how the IP gets flagged.

Concurrency is 1 across the whole browser, since one Firefox runs on one Pi. The queue holds 5
requests and returns 429 when full.

Other routes: `PUT /profiles/:name/state` accepts a `storageState` JSON from the login CLI, and
`GET /healthz` reports liveness.

State lives on one small Longhorn PVC mounted in the gateway at `/state/<profile>.json`.
A secret manager holds a backup copy.

### 4. Login CLI

`pnpm signin <profile>` runs on the operator's Mac.

1. Launch Camoufox headed, locally, with `profiles/fingerprint.json`. The Mac and the Pis share
   the home IP, so IP and fingerprint both match what the server uses.
2. Open the site's sign-in page. The operator logs in by hand, handling 2FA and captchas as
   usual, then presses Enter in the terminal.
3. Save `storageState`, `PUT` it to the gateway over Tailscale, and store a backup in the secret
   manager as `stealth-browser - <profile> session`.

`pnpm signin ebay --signup` opens eBay registration instead of sign-in. The operator creates the
scraping account in that window, then enables Seller Hub and Terapeak there. This one-time setup is a manual plan task with a checklist, and smoke test 3 waits on it.

### 5. Exposure

- Tailscale ingress for the gateway only, at hostname `stealth-browser`
  (`https://stealth-browser.<tailnet>.ts.net`).
- Agents browse multi-step flows (Amazon search, open results, paginate) with repeated
  `/content` calls and URL-built queries such as `amazon.com/s?k=...`. There is no raw Playwright
  WebSocket ingress, because it would bypass throttling and block detection.

### 6. Secrets

All in a secret manager, read by one batched call in `deploy.sh`:

- `stealth-browser - gateway token`
- `stealth-browser - ws path`
- `stealth-browser - ebay session` and `stealth-browser - reddit session` (documents, backup copies)

`deploy.sh` creates k8s Secrets for the token and ws path. It seeds a session file onto the PVC
only when that file is missing and never overwrites a live one. Nothing secret goes in git.

### 7. Build

Build ARM64 images on an Apple Silicon Mac with `docker buildx --platform linux/arm64` and push them to
GHCR with exact version tags, never `:latest`. CI builds are out of scope for v1 because the
ai-listings self-hosted arm64 runner is scoped to that repo.

### 8. Cutover

1. Deploy next to the old Browserless and run the smoke tests.
2. Point callers at the new service:
   - The operator's shell environment: keep the variable names `BROWSERLESS_URL` and `BROWSERLESS_TOKEN`, change the values.
   - `agent-skills/skills/web-research/references/browserless.md`: add Amazon hosts to the
     known-blocking list, and document the 423, 401, and 429 responses and the `profile` field.
   - `ai-listings/.claude/commands/reprice.md`: handle 423 and 401.
   - `url-verify.ts:42`: replace the hardcoded URL with an env var.
3. Delete `ai-listings/deployment/kubernetes/browserless/`, its deploy script, and the old
   Deployment, Secret, and ingress.

## Calls made without the operator's input

- The repo name, `stealth-browser`.
- One shared fingerprint and one Camoufox pod rather than one per site. Without a proxy, separate
  fingerprints add nothing, and each one costs a Firefox on the Pis.
- The 30-minute pause per profile after a block.
- The cluster copy of a login wins over the secret-manager backup, which is a disaster-recovery snapshot.
- No raw Playwright WebSocket ingress in v1.

## Left to the builder

HTTP framework and libraries (`joe-stack-preferences`), exact challenge-marker strings (capture
real challenge pages as test fixtures), throttle numbers after the first runs, how to generate the
fingerprint JSON, and node placement.

## Process

1. This spec is the first commit on `feat/stealth-browser-v1`.
2. `superpowers:writing-plans`, then subagent-driven execution, all on that branch, shipped as
   one PR through `/no-mistakes`.
3. Caller changes in agent-skills and ai-listings go out as separate small PRs once the smoke
   tests pass.

## Verification

Unit tests, written test-first against fixture HTML, cover host-to-profile routing, block and
session-expired detection on captured eBay challenge and Reddit login-wall pages, the 30-minute
pause after a 423, and the 429 when the queue is full.

`pnpm smoke` runs against the deployed gateway:

1. browserleaks or CreepJS shows a New York timezone and no `webdriver` flag.
2. eBay sold search (`/sch/i.html?_nkw=...&LH_Sold=1&LH_Complete=1`) returns 200 with sold-price
   items and no challenge markers.
3. A Terapeak research URL returns signed-in content.
4. A login-walled Reddit thread returns content, and an `old.reddit.com` search returns results.
5. An Amazon `s?k=` search and one product page return titles and prices.
6. With the `ebay` state file deleted, a request returns 401 `session_expired`.

Then run `/reprice` end to end on one real listing.

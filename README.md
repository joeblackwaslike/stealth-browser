# stealth-browser

A self-hosted scraping gateway for sites that block automated browsers. You POST a URL
and get back the rendered HTML, fetched by [Camoufox](https://github.com/daijro/camoufox),
a patched Firefox with a pinned fingerprint. eBay and Reddit requests can reuse a saved
logged-in session.

Use it when a plain HTTP fetch or headless Chrome gets a 403, a 429, a CAPTCHA, a login
wall, or a near-empty body from a page that should be server-rendered. For ordinary sites
a normal fetch is faster and cheaper.

## Architecture

Two deployments run in the `stealth-browser` namespace of a Kubernetes cluster (built
and run on k3s):

- `gateway` is a [Hono](https://hono.dev) service on port 8080. It checks the bearer
  token, picks a profile, queues the request, drives the browser over Playwright's remote
  protocol, and classifies the page it gets back. Saved sessions and debug captures live
  on a 1 Gi PVC mounted at `/state`.
- `camoufox` runs Camoufox as a remote Playwright server on port 3000, behind a secret
  WebSocket path. It draws on an Xvfb screen the same size as the fingerprint claims.

Each request gets a fresh browser context loaded with the profile's saved
`storageState`. Images, media, and fonts are not downloaded. The gateway uses no proxy,
so traffic leaves from the node's own IP, and Camoufox's geoip fills the WebRTC IP and
geolocation from that exit IP at launch.

`deploy/k8s/ingress.yaml` exposes the gateway through the Tailscale Kubernetes operator
(ingress class `tailscale`). Remove it from `kustomization.yaml` or swap in your own
ingress if you don't use Tailscale.

## API

Every route requires `Authorization: Bearer <token>`.

`GET /healthz` returns `{"ok":true}`.

`PUT /profiles/<ebay|reddit>/state` replaces a profile's saved session with a Playwright
`storageState` JSON body and returns 204. `pnpm signin` uses it.

`POST /content` fetches a page:

```bash
curl -sS -m 300 -X POST "$STEALTH_BROWSER_URL/content" \
  -H "Authorization: Bearer $STEALTH_BROWSER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://old.reddit.com/r/selfhosted/"}'
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `url` | string | required | Public `http`/`https` only. Loopback, private IPs, `localhost`, `.local`, `.svc`, `.cluster.local`, and bare hostnames are rejected. |
| `waitForTimeout` | int, 0-15000 ms | 3000 | Extra wait after `domcontentloaded`, for lazy-loaded content. |

The URL check looks at the literal hostname only. Redirects and DNS names that
resolve to a private address are stopped one layer down: a NetworkPolicy
(`deploy/k8s/camoufox-networkpolicy.yaml`) denies the Camoufox pod egress to
every non-public IPv4 range (see that file for the full list). The same policy lets only the
gateway pods connect to Camoufox, so no other workload in the cluster can drive
the browser. It only takes effect on a cluster whose network plugin enforces
NetworkPolicy (k3s does by default).

A 200 returns the rendered HTML as `text/html`, with the post-redirect URL in the
`X-Final-Url` header.

### Profiles

The gateway picks the profile from the URL's hostname. A profile owns its domain and
every subdomain of it:

| Host | Gap between requests | Pauses after an unsolved block | Saved login |
| --- | --- | --- | --- |
| `ebay.com`, `*.ebay.com` | 20-40 s | yes | yes |
| `reddit.com`, `*.reddit.com` | 5-10 s | yes | yes |
| `google.com`, `*.google.com` | 8-15 s | no | no |
| any other host | 3-8 s | no | no |

Gaps are random within the range. Each other host is paced on its own, so a slow
`example.com` does not delay `example.org`.

Matching follows label boundaries, so `notebay.com` and `ebay.com.example` go to `anon`.
After a successful fetch on a login profile, the gateway saves the updated cookies back
to the store, unless a newer session was uploaded while the request ran.

### Errors

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{"error":"invalid_request","message":...}` | Bad body or disallowed URL |
| 401 | not JSON | Token missing or wrong |
| 401 | `{"session_expired":true,"profile":...}` | No saved session, or the site redirected to its sign-in page |
| 423 | `{"blocked":true,"profile":...,"host":...,"reason":...,"marker":...,"html":...,"capture":...}` | The site served a bot check. On eBay and Reddit the profile is also paused for 30 minutes. No `Retry-After` header |
| 423 | `{"blocked":true,"profile":...,"reason":"paused"}` plus `Retry-After` (seconds) | The profile is still paused from an earlier block |
| 429 | `{"error":"rate_limited","profile":...}` | The site answered 429; no pause |
| 429 | `{"error":"queue_full"}` | The queue is full |
| 500 | `{"error":"state_unavailable","profile":...}` | Reading the saved session failed |
| 500 | `{"error":"state_write_failed","profile":...}` | `PUT /profiles/:name/state` failed to persist |
| 502 | `{"error":"navigation_failed","message":...}` | Navigation failed or timed out |

A fresh block's 423 body has these fields:

- `blocked` is always `true`.
- `profile` is the matched profile and `host` is the requested hostname.
- `reason` is one of `ebay_challenge_redirect`, `interruption_page`, `ebay_error_page`,
  `captcha`, `verify_human`, `google_sorry` (Google's `/sorry` page, even when served with
  429), or `http_block_status` (the site answered 403).
- `marker` is the exact check that matched: `ebay_challenge_redirect`, `interruption_page`,
  `ebay_error_page`, `captcha_widget:g-recaptcha`, `captcha_widget:h-captcha`,
  `captcha_widget:amazon`, `verify_human`, `google_sorry`, or `http_block_status`.
- `html` is the page the site served.
- `capture` is the file name of the copy saved under `/state/captures` (newest 20 kept).
  It is left out when the save fails.

The `paused` 423 comes from the gateway without fetching anything, so it has no `host`,
`marker`, `html`, or `capture`. `html` can be large, so extract only the fields you need
(for example `jq -r '.marker'`) instead of printing the whole body.

Session expiry means the eBay request landed on `signin.ebay.com`, or the Reddit request
landed on `/login` or came back without a `reddit_session` cookie. On a detected expiry the
gateway saves the page HTML under `/state/captures` too.

### Pacing

There is one browser, so requests run one at a time in FIFO order. Between two starts
on the same key the gateway waits a random gap from the host table above. The key is the
profile for eBay, Reddit and Google, and the hostname for everything else. One request runs
and up to five wait; a seventh gets `queue_full`. A request can wait a minute or more,
so give clients a long timeout.
Navigation times out after 30 s.

### Solver

The gateway can send reCAPTCHA v2 challenges to a 2Captcha-compatible service. It is off
unless `SOLVER_API_KEY` is set. With a key set, it runs on every host, up to
`SOLVER_MAX_PER_HOUR` attempts per hour (default 100), failed attempts included. The budget
lives in memory, so a pod restart resets it. The gateway assumes a single replica.

The solver only acts on a challenge form: a visible `<div class="g-recaptcha">` widget
inside a form whose fields are all hidden inputs, buttons, and the response textarea, with
nothing `contenteditable`. Anything else gets no solve and no submit, and is not classified
as a block: a widget outside a form, an invisible widget (`data-size="invisible"`), a widget
bound to a button (a one-click unsubscribe or vote), or a form a person fills in (a login
form with text inputs, a comment form with a rich-text editor).

When a fetched page has such a form with a sitekey, the gateway checks the form again in the
live page, before asking the solver and again before filling it, and gives up with `no_form`
if the form does not pass. Otherwise it asks the solver for a token, fills
`g-recaptcha-response`, submits the form, and waits for navigation. It solves
at most once per fetch. If the solver or the form fails (solver timeout, provider error,
budget used up, no form on the page), the gateway returns the original page and classifies
it as usual. A challenge page is `blocked` unless it came back with HTTP 429, so the client
gets a 423 and, on eBay and Reddit, the profile pauses for 30 minutes. A challenge page
served with HTTP 429 is `rate_limited` instead: the client gets a 429 and nothing pauses.
The one exception is Google's `/sorry` page, which is `blocked` on any status, 429
included. If the solver returns a token and the site rejects it, the gateway returns the
page after the submit and classifies it like any other page. The `solve_failed` warning in
the gateway log carries the failure `reason`. When an error exists, `err` holds its class
and message, with the solver key and Camoufox endpoint redacted.

With a solver, a request can take about 240 s plus any queue wait. The deadline adds up to
30 s connect, 30 s navigation, 0-15 s `waitForTimeout`, 15 s margin, 120 s solver and 30 s
for the submit navigation. That is 228 s at the default `waitForTimeout` and 240 s at most.
The browser slot can stay held up to 10 s past the deadline (250 s), and each request queued
ahead adds that much. Set client timeouts to 300 s or more.

Google's terms restrict automated querying of Search. Not yet verified against Google's
/sorry page.

In the cluster, the key comes from the optional `solverApiKey` entry in the
`stealth-browser-secrets` secret. Without that entry the pod starts with the solver off.

## Configuration

The gateway reads these environment variables at startup and fails to start on an invalid
value.

| Variable | Required | Default | Effect |
| --- | --- | --- | --- |
| `GATEWAY_TOKEN` | yes | none | Bearer token for every route. At least 32 characters. |
| `CAMOUFOX_WS_URL` | yes | none | WebSocket URL of the Camoufox server. Must start with `ws://` or `wss://`. |
| `STATE_DIR` | no | `/state` | Where saved sessions and captures are stored. |
| `PORT` | no | `8080` | Listen port, 1-65535. |
| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `SOLVER_API_KEY` | no | unset | Solver API key. Unset turns the solver off. |
| `SOLVER_BASE_URL` | no | `https://2captcha.com` | Solver base URL. Must be `https://`. A path prefix such as `/api` is kept. |
| `SOLVER_MAX_PER_HOUR` | no | `100` | Positive integer. Solve attempts allowed per hour. |

An empty value counts as unset. `SOLVER_PROFILES` is gone; setting it does nothing.

## Setup

You need:

- a Kubernetes cluster with a storage class for the 1 Gi PVC (it asks for `longhorn`;
  edit `deploy/k8s/pvc.yaml` for yours)
- a container registry (the manifests and `scripts/build.sh` point at GHCR)
- `kubectl`, `jq`, `openssl`, and `docker buildx` on your workstation
- Node 22+ and pnpm, plus [uv](https://docs.astral.sh/uv/) for the Python scripts

1. Set your registry. Replace `ghcr.io/joeblackwaslike` in `scripts/build.sh`,
   `deploy/k8s/camoufox-deployment.yaml`, and `deploy/k8s/gateway-deployment.yaml`.
2. Build and push both images with `scripts/build.sh`. It refuses to run on a dirty
   tree, so every tag maps to a commit. It builds `linux/arm64` only; change
   `--platform` for amd64 nodes (the Camoufox Dockerfile already handles both). The
   gateway tag comes from `package.json`; the Camoufox tag defaults to `156.0.1-2`
   (override with `CAMOUFOX_TAG`).
3. Deploy with `deploy/deploy.sh`. It creates the namespace, copies a `ghcr-credentials`
   pull secret from another namespace (point that line at your own pull secret, or drop
   it and the `imagePullSecrets` entries if your images are public), applies the
   manifests, and waits for both rollouts.
4. Read the gateway token:

   ```bash
   kubectl get secret stealth-browser-secrets -n stealth-browser \
     -o jsonpath='{.data.gatewayToken}' | base64 -d
   ```

On its first run `deploy.sh` creates `stealth-browser-secrets` with two random values:
`gatewayToken` (the bearer token) and `wsPath` (the Camoufox WebSocket path, the only
thing guarding that endpoint). Later runs never rotate them.

Clients and the scripts below read `STEALTH_BROWSER_URL` (for example
`https://stealth-browser.example.ts.net`) and `STEALTH_BROWSER_TOKEN` from the
environment.

## Capturing logins

```bash
pnpm signin ebay      # or: pnpm signin reddit
pnpm signin ebay --signup   # opens eBay's account sign-up page instead
```

This runs on macOS and needs `kubectl` access to the cluster plus `STEALTH_BROWSER_URL`
and `STEALTH_BROWSER_TOKEN`. The script starts a one-time x11vnc server inside the
camoufox pod with a random password, port-forwards it and the browser endpoint to your
Mac, and opens the site's sign-in page in the cluster's own Camoufox. Screen Sharing
opens on that browser window. Log in by hand, then press Enter in the terminal. The
script uploads the session's cookies and local storage to `PUT /profiles/<name>/state`
and stops x11vnc.

The login happens in the same browser process that later replays the session, so the
build, fonts, TLS fingerprint, and exit IP all match. Your password is typed into the
remote browser and never reaches the script. The captured session goes straight from
memory to the gateway and is never written to your disk. For Reddit, the script waits
until a `reddit_session` cookie exists before uploading.

## Fingerprint

`profiles/fingerprint.json` pins one Linux identity: Firefox 156 user agent, a 1440x900
screen, locale `en-US`, timezone `America/New_York`. Every Camoufox launch reuses the
same user agent, screen, fonts, WebGL values, and noise seeds, so sites with a saved
session keep seeing the same browser. Locale and timezone are pinned because Camoufox's
geoip would otherwise draw a random locale for the exit IP's region on every launch.

If your exit IP is somewhere else, set your own locale and timezone:

1. Edit `PINNED` in `scripts/gen_fingerprint.py`.
2. Run `uv run scripts/gen_fingerprint.py`. It reads the user agent from the Camoufox
   build active on your machine, so activate the same build the server image uses
   (`CAMOUFOX_BROWSER_VERSION` and `CAMOUFOX_BUILD_*` in `camoufox/Dockerfile`) first.
   It overwrites `profiles/fingerprint.json`.
3. Update `EXPECTED_TIMEZONE` in `scripts/verify-fingerprint.ts`.
4. Run `deploy/deploy.sh`, then `kubectl -n stealth-browser rollout restart
   deploy/camoufox` so the pod loads the new ConfigMap.

## Smoke tests

```bash
pnpm smoke                   # all checks
pnpm smoke reddit amazon     # named checks
pnpm smoke:fingerprint
```

Checks are `fingerprint`, `ebaySold`, `terapeak`, `reddit`, and `amazon`. All of them
need `STEALTH_BROWSER_URL` and `STEALTH_BROWSER_TOKEN`. `terapeak` also needs
`TERAPEAK_URL` set to an eBay Seller Hub research URL. `fingerprint` port-forwards to the
camoufox pod with `kubectl` and checks that two connections report the same identity.
Set `SMOKE_OUT=<dir>` to save each passing page. Pages from the eBay and Reddit profiles
contain session tokens, so redact them before committing one as a fixture.

## Development

```bash
pnpm install
pnpm test               # unit tests
pnpm lint               # biome
pnpm typecheck
pnpm build
CAMOUFOX_WS_URL=ws://localhost:3000/<ws-path> pnpm test:integration
```

## Credits

[Camoufox](https://github.com/daijro/camoufox) is licensed under MPL-2.0. The image
installs the `cloverlabs-camoufox` Python wrapper and downloads the official browser
builds. `camoufox/Dockerfile` and `camoufox/launch_server.py` are adapted from
[rjocoleman/camoufox-server](https://github.com/rjocoleman/camoufox-server) under the MIT
License; see `camoufox/NOTICE`.

## License

MIT; see [LICENSE](LICENSE).

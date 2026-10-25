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
curl -sS -m 180 -X POST "$STEALTH_BROWSER_URL/content" \
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
private, CGNAT, loopback and link-local ranges. The same policy lets only the
gateway pods connect to Camoufox, so no other workload in the cluster can drive
the browser. It only takes effect on a cluster whose network plugin enforces
NetworkPolicy (k3s does by default).

A 200 returns the rendered HTML as `text/html`, with the post-redirect URL in the
`X-Final-Url` header.

### Profiles

The gateway picks the profile from the URL's hostname. A profile owns its domain and
every subdomain of it:

| Hostname | Profile | Session |
| --- | --- | --- |
| `ebay.com`, `*.ebay.com` | `ebay` | saved login |
| `reddit.com`, `*.reddit.com` | `reddit` | saved login |
| anything else | `anon` | none |

Matching follows label boundaries, so `notebay.com` and `ebay.com.example` go to `anon`.
After a successful fetch on a login profile, the gateway saves the updated cookies back
to the store, unless a newer session was uploaded while the request ran.

### Errors

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{"error":"invalid_request","message":...}` | Bad body or disallowed URL |
| 401 | not JSON | Token missing or wrong |
| 401 | `{"session_expired":true,"profile":...}` | No saved session, or the site redirected to its sign-in page |
| 423 | `{"blocked":true,"profile":...,"reason":...}` | The site served a bot check; the profile is now paused for 30 minutes |
| 423 | same, `"reason":"paused"`, plus `Retry-After` (seconds) | The profile is still paused from an earlier block |
| 429 | `{"error":"rate_limited","profile":...}` | The site answered 429; no pause |
| 429 | `{"error":"queue_full"}` | The queue is full |
| 502 | `{"error":"navigation_failed","message":...}` | Navigation failed or timed out |

A fresh block's `reason` is one of `ebay_challenge_redirect`, `interruption_page`,
`ebay_error_page`, `captcha`, `verify_human`, or `http_block_status` (the site answered
403). Session expiry means the eBay request landed on `signin.ebay.com`, or the Reddit
request landed on `/login` or came back without a `reddit_session` cookie. On a fresh block or
a detected expiry, the gateway saves the page HTML under `/state/captures`, keeping the newest 20.

### Pacing

There is one browser, so requests run one at a time in FIFO order. Between two starts
on the same profile the gateway waits a random gap: 20-40 s for `ebay`, 5-10 s for
`reddit`, 3-8 s for `anon`. One request runs and up to five wait; a seventh gets
`queue_full`. A request can wait a minute or more, so give clients a long timeout.
Navigation times out after 30 s.

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
2. Run `uv run scripts/gen_fingerprint.py`. It needs a fetched Camoufox browser on the
   machine and overwrites `profiles/fingerprint.json`.
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

The gateway reads `GATEWAY_TOKEN` (32+ characters), `CAMOUFOX_WS_URL`, `STATE_DIR`
(default `/state`), `PORT` (default 8080), and `LOG_LEVEL` (default `info`).

## Credits

[Camoufox](https://github.com/daijro/camoufox) is licensed under MPL-2.0. The image
installs the `cloverlabs-camoufox` Python wrapper and downloads the official browser
builds. `camoufox/Dockerfile` and `camoufox/launch_server.py` are adapted from
[rjocoleman/camoufox-server](https://github.com/rjocoleman/camoufox-server) under the MIT
License; see `camoufox/NOTICE`.

## License

MIT; see [LICENSE](LICENSE).

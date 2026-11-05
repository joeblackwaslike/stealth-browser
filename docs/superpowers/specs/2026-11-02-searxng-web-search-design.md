# SearXNG web search for OpenClaw

Copied from openclaw-setup (branch feat/searxng-stealth-google); paths in this document refer to that repo.

## Intent

OpenClaw has no `web_search` provider configured. Joe wants the agent to search the web through a SearXNG instance he runs himself on the Pi k3s cluster. That avoids search API keys and per-query billing, and no search account ties the queries to him. SearXNG still forwards each query to its upstream engines (Google, Bing, DuckDuckGo and others), which see the request coming from the cluster's IP. For now OpenClaw is the only client; using SearXNG as a browser search engine is out of scope.

## Goals

- A SearXNG instance on the Pi cluster, reachable only from the tailnet at `https://search.napoleon-catfish.ts.net`.
- OpenClaw's `web_search` tool uses it through the official `@openclaw/searxng-plugin`.
- Both halves are reproducible from this repo: manifests plus a deploy script for the cluster, and an `install.sh` step for the Mac.

## Non-goals

- Browser use: no autocomplete, image proxy, theme, or engine tuning beyond SearXNG's defaults.
- Public exposure: no Cloudflare tunnel route and no Traefik ingress.
- The Valkey/Redis-backed rate limiter. The only client is one agent on a private network.

## Anti-goals

- The SearXNG secret key committed to git, or set in launchd env.
- A plain-HTTP or public base URL that would need OpenClaw's SSRF guard loosened.
- Web search that silently falls back to a paid or keyed provider when SearXNG is down.

## Constraints

- The cluster is k3s on three Raspberry Pi 5 nodes (arm64). The image must have an arm64 build. `searxng/searxng` publishes amd64, arm64, and arm.
- Pin the image to an exact tag at least two weeks old, never `latest`.
- Private services on this cluster use a Tailscale Ingress (`ingressClassName: tailscale`, annotation `tailscale.com/proxy-group: cluster-ingress`), as `home-assistant/ha-ts` does. SearXNG follows that pattern.
- OpenClaw's SearXNG plugin requires the JSON output format (`search.formats` includes `json`). An `http://` base URL must point at a private or loopback host. An `https://` URL that resolves to a private address gets the self-hosted allowance. OpenClaw 2026.10.9 classifies `100.64.0.0/10` (Tailscale) as private (`PRIVATE_OR_LOOPBACK_IPV4_RANGES` in `dist/ip-*.mjs`). This comes from reading the source; confirm it with a live `web_search` call.
- The plugin is external, so `searxng` goes into `plugins.allow` (the repo pins plugins).
- Project rules still apply: Homebrew-only OpenClaw, no secrets in the repo, and a CHANGELOG entry with every commit.

## Approaches

1. **Plain manifests in this repo, applied with `kubectl apply -k` (chosen).** A deployment, a ConfigMap holding a minimal `settings.yml`, a Service, and a Tailscale Ingress, in `k8s/searxng/`. A deploy script generates the secret key into a cluster Secret on first run. This needs no new tooling and matches how other private services are exposed.
2. **Community Helm chart.** There is no official chart, community charts lag the image, and `settings.yml` would still need overriding. It adds a dependency to save about 80 lines.
3. **LAN LoadBalancer IP from MetalLB (`http://192.168.1.1x`).** This passes the SSRF guard for certain, but search breaks whenever the Mac is off the home network. It stays as the fallback if the Tailscale URL fails the guard.

Joe picked approach 1.

## Design

### Cluster (`k8s/searxng/`)

- `namespace.yaml`: the `searxng` namespace.
- `configmap.yaml`: `settings.yml` with `use_default_settings: true`, `server.limiter: false`, `server.image_proxy: false`, and `search.formats: [html, json]`. It contains no secret key.
- `deployment.yaml`: 1 replica of `searxng/searxng:<pinned tag>`. The secret key comes from Secret `searxng` key `secret-key` through the `SEARXNG_SECRET` env var. The settings file is mounted from the ConfigMap. Readiness and liveness probes hit `/healthz` on port 8080. It sets resource requests and limits sized for a Pi, and runs as non-root.
- `service.yaml`: a ClusterIP service on port 8080.
- `ingress.yaml`: a Tailscale Ingress with hostname `search`, proxy group `cluster-ingress`, and TLS. That gives `https://search.napoleon-catfish.ts.net`.
- `kustomization.yaml`: lists the files above.
- `deploy.sh`: creates the namespace, creates Secret `searxng` with `openssl rand -hex 32` only if it doesn't already exist (so redeploys keep the key), runs `kubectl apply -k`, and waits for the rollout.

### OpenClaw (`install.sh`, config template)

- An `install_web_search` step: run `openclaw plugins install @openclaw/searxng-plugin` (idempotent), then set:
  - `tools.web.search.provider = "searxng"`
  - `plugins.entries.searxng.config.webSearch.baseUrl = "https://search.napoleon-catfish.ts.net"`
  - `searxng` added to `plugins.allow`
- If the URL doesn't answer `/healthz`, the step warns and points at `k8s/searxng/deploy.sh`. It doesn't fail the install, because the cluster is separate infrastructure.
- `config/openclaw.json.example` is refreshed from live with `/sync-from-live`.
- `docs/web-search.md` gets a short page: what runs where, how to deploy or redeploy, how to check it, and known failure modes.

## Verification

- `kubectl -n searxng rollout status deploy/searxng` succeeds and the pod runs on an arm64 node.
- `curl -s 'https://search.napoleon-catfish.ts.net/search?q=openclaw&format=json' | jq '.results | length'` returns more than 0 from the Mac over the tailnet.
- The OpenClaw gateway lists the SearXNG plugin as loaded and `tools.web.search.provider` resolves to `searxng`.
- A live agent `web_search` call returns results, which confirms the SSRF guard accepts the Tailscale URL.
- Failure mode: scale the deployment to 0, check that `web_search` reports an error instead of switching to another provider, then scale back to 1.

## Left to the builder

- The exact image tag. Pick the newest tag that is at least two weeks old, with a passing arm64 pull.
- Resource numbers, and whether `readOnlyRootFilesystem` works with an `emptyDir` for the cache directory. Use it if the container starts cleanly with it.
- How `install.sh` writes config: `openclaw config set` or `openclaw config patch`, whichever is idempotent for the allowlist append.

# SearXNG Web Search Implementation Plan

Copied from openclaw-setup (branch feat/searxng-stealth-google); paths in this document refer to that repo.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run SearXNG on the Pi k3s cluster behind a Tailscale Ingress and make it OpenClaw's `web_search` provider.

**Architecture:** Plain Kubernetes manifests in `k8s/searxng/`, applied with `kubectl apply -k` by `k8s/searxng/deploy.sh`, which also creates the secret key once. `install.sh` gains `install_web_search`, which installs `@openclaw/searxng-plugin` and points it at the tailnet URL. Cluster and Mac stay decoupled: the installer warns if the URL is down and never touches the cluster.

**Tech Stack:** k3s (arm64), kustomize via `kubectl -k`, Tailscale operator Ingress, Stakater Reloader, bash, jq, `openclaw` CLI 2026.10.9.

**Spec:** `docs/superpowers/specs/2026-11-02-searxng-web-search-design.md`

## Global Constraints

- Image `searxng/searxng:2026.10.17-2a6fc07be` (arm64 published; never `latest`).
- URL `https://search.napoleon-catfish.ts.net`; Ingress `ingressClassName: tailscale`, annotations `tailscale.com/hostname: search`, `tailscale.com/proxy-group: cluster-ingress`, `tls.hosts: [search]` (copy of `home-assistant/ha-ts`).
- Secret key never in git or launchd env: Secret `searxng`, key `secret-key`, injected as env `SEARXNG_SECRET` (read by `searx/settings_defaults.py:219`).
- `settings.yml`: `use_default_settings: true`, `server.limiter: false`, `server.image_proxy: false`, `search.formats: [html, json]`.
- No Cloudflare tunnel route, no Traefik ingress, no Valkey.
- OpenClaw: `tools.web.search.provider = "searxng"`, `plugins.entries.searxng.config.webSearch.baseUrl = "https://search.napoleon-catfish.ts.net"`, `searxng` in `plugins.allow`.
- Homebrew-only OpenClaw; every commit updates `CHANGELOG.md` (Keep a Changelog, what + why).
- Container facts: listens on 8080, runs as uid/gid 977, health at `GET /healthz`.

## Review Focus

- Running `deploy.sh` a second time must keep the existing secret key (pod env value identical before and after). Test in Task 1.
- Re-running `install_web_search` on a configured machine must not reinstall the plugin or duplicate `searxng` in `plugins.allow`. Test in Task 2.
- Mac off the tailnet / SearXNG down during install: `install.sh` warns and continues (exit 0). Test in Task 2.
- SearXNG down at query time: `web_search` reports an error and does not switch to another provider. Test in Task 2.
- Editing the ConfigMap must restart the pod (Reloader annotation), otherwise settings changes silently don't apply. Test in Task 1.

---

### Task 1: SearXNG on the cluster

**Files:**
- Create: `k8s/searxng/kustomization.yaml`, `namespace.yaml`, `configmap.yaml`, `deployment.yaml`, `service.yaml`, `ingress.yaml`, `deploy.sh`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: namespace `searxng`; Deployment/Service `searxng` (port 8080); Secret `searxng` key `secret-key`; reachable `https://search.napoleon-catfish.ts.net/search?q=<q>&format=json`. `deploy.sh` takes no args, uses the current kubectl context, exits non-zero on rollout failure.

- [ ] **Step 1: Confirm the gap.** Run `curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://search.napoleon-catfish.ts.net/healthz`. Expected: non-200 (000).
- [ ] **Step 2: Write manifests.** Deployment details: 1 replica; `metadata.annotations: reloader.stakater.com/auto: "true"`; `securityContext` runAsNonRoot, runAsUser/Group 977, fsGroup 977, `allowPrivilegeEscalation: false`, drop ALL caps; ConfigMap `searxng-settings` mounted at the image's `__SEARXNG_CONFIG_PATH` (expected `/etc/searxng`; confirm with `kubectl run --rm -it --image=<pinned> -- printenv __SEARXNG_CONFIG_PATH` or `docker inspect`), `emptyDir` at `__SEARXNG_DATA_PATH`; env `SEARXNG_SECRET` from Secret; readiness + liveness `httpGet /healthz :8080`; requests `50m`/`128Mi`, limits `512Mi` memory, no CPU limit. Try `readOnlyRootFilesystem: true`; drop it only if the pod fails to start, and note why in the CHANGELOG.
- [ ] **Step 3: Write `deploy.sh`** (`set -euo pipefail`): `kubectl apply -f namespace.yaml`; create Secret only if `kubectl -n searxng get secret searxng` fails, value `openssl rand -hex 32` via `--from-literal`; `kubectl apply -k "$(dirname "$0")"`; `kubectl -n searxng rollout status deploy/searxng --timeout=180s`. Shellcheck clean.
- [ ] **Step 4: Validate.** `kubectl apply -k k8s/searxng --dry-run=server` succeeds.
- [ ] **Step 5: Deploy.** `k8s/searxng/deploy.sh`. Expected: rollout success; pod `Running` on an arm64 node.
- [ ] **Step 6: Verify end to end.** `curl -s 'https://search.napoleon-catfish.ts.net/search?q=openclaw&format=json' | jq '.results | length'` > 0 (the Tailscale cert can take ~1 min on first hit).
- [ ] **Step 7: Review Focus checks.** Record `kubectl -n searxng get secret searxng -o jsonpath='{.data.secret-key}' | shasum`, re-run `deploy.sh`, hash identical. Edit a harmless ConfigMap value (e.g. add `general.instance_name: searxng`), apply, confirm pod restarts (new pod name) and stays Ready; keep the edit only if useful.
- [ ] **Step 8: Commit** manifests + CHANGELOG entry (`feat: deploy SearXNG to the Pi cluster`).

### Task 2: OpenClaw uses SearXNG

**Files:**
- Modify: `install.sh` (new constants near `OLLAMA_URL`, new `install_web_search`, call in `main` after `install_memory`), `config/openclaw.json.example`, `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1's URL.
- Produces: `install_web_search()` (no args); constants `SEARXNG_URL="https://search.napoleon-catfish.ts.net"`, `SEARXNG_PLUGIN="@openclaw/searxng-plugin"`.

- [ ] **Step 1: Confirm the gap.** `openclaw config get tools.web.search.provider` is unset; `searxng` absent from `plugins.allow`.
- [ ] **Step 2: Implement `install_web_search`.** Install the plugin only if `openclaw plugins list` (JSON form if available) doesn't show `searxng`. If `plugins.allow` is a non-empty array without `searxng`, append it (`. + ["searxng"]`, order kept) with `openclaw config set plugins.allow ... --strict-json`; if it is unset, null or empty, leave it alone and `warn` (appending would narrow an unpinned config to searxng only); if it already has `searxng`, don't write. Then provider and baseUrl in one `openclaw config set --batch-json`. Health probe `curl -sf --connect-timeout 2 --max-time 5 "$SEARXNG_URL/healthz"`; on failure `warn` naming `k8s/searxng/deploy.sh` and continue. Match existing style (`info`/`warn`, no banners). Replace the final `main "$@"` with `if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi` so the function can be sourced for tests and the live apply. Shellcheck clean.
- [ ] **Step 3: Stub test** in the scratchpad: PATH-stubbed `openclaw`/`curl` that log calls, then `source install.sh && install_web_search`. For the RED run, source a disposable copy of the pre-change `install.sh` with its final `main "$@"` line removed, because sourcing the original runs the whole installer. Assert (a) second run issues no `plugins install` and no allow write; (b2) unset, null and empty allowlists produce a warning and no write; (b) failing `curl` → warning, exit 0. Run, show output.
- [ ] **Step 4: Apply live.** Back up `~/.openclaw/openclaw.json` to `.pre-searxng`, then `bash -c 'source ./install.sh && install_web_search'` (works because of the source guard from Step 2). Restart gateway (`openclaw gateway restart`).
- [ ] **Step 5: Verify live.** Gateway shows the searxng plugin loaded; a real agent `web_search` call (e.g. `openclaw agent --message "search the web for SearXNG and give one result URL"` or the equivalent CLI) returns a result whose URL came from SearXNG; gateway log shows provider `searxng`. This is the SSRF-guard check; if it rejects the URL, stop and report (fallback = MetalLB IP, needs a spec change).
- [ ] **Step 6: Failure mode.** `kubectl -n searxng scale deploy/searxng --replicas=0`; repeat the agent call; expected an error naming SearXNG, no other provider used; scale back to 1 and wait Ready.
- [ ] **Step 7: Sync template** per `/sync-from-live` (same jq scrub as the previous sync: drop `wizard`, `mcp`, `meta.lastTouched*`; placeholder gateway token and owner id; `/Users/joe` → `~`), validate with `OPENCLAW_CONFIG_PATH=<template copy> openclaw config validate --json`, secret-scan the diff (`sk-ant-`, `ops_ey`, bot tokens, JWTs).
- [ ] **Step 8: Commit** (`feat: make SearXNG OpenClaw's web_search provider`) with CHANGELOG.

### Task 3: Docs

**Files:**
- Create: `docs/web-search.md`
- Modify: `AGENTS.md` (File layout: add `k8s/searxng/`), `README.md` (if it lists components/docs), `CHANGELOG.md`

- [ ] **Step 1: Write `docs/web-search.md`:** what runs where, deploy/redeploy (`k8s/searxng/deploy.sh`), checks (curl JSON, agent call), known failure modes (cluster down → `web_search` errors; first Tailscale cert delay; secret rotation = delete Secret + redeploy). Run `no-ai-slop` edit mode then `humanizer` embedded on it before saving.
- [ ] **Step 2: Update AGENTS.md file layout and README.** Load `agent-skills:agent-instructions` before editing AGENTS.md.
- [ ] **Step 3: Commit** (`docs: document SearXNG web search`) with CHANGELOG.

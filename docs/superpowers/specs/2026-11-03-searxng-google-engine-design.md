# SearXNG google engine design

## Why

Joe expected the SearXNG instance's Google path to stop working on Jan 1 and wanted Google results to come through this gateway, which now solves `/sorry/` reCAPTCHAs. The captcha solver spec (`2026-11-03-captcha-solver-design.md`) assigned the SearXNG side to a separate plan in `openclaw-setup`. This design covers the engine.

Findings that shaped it:

- The instance does not use Google Custom Search. Its `settings.yml` is `use_default_settings: true` with no engines block, API key or cx. It runs SearXNG's built-in `google` engine, which scrapes google.com with a Nokia feature-phone User-Agent to get a non-JS XML layout.
- The Programmable Search shutdown therefore does not threaten this instance. What changes on Jan 1 for the scrape path was not verified.
- The built-in parser cannot be reused. It parses the Nokia-UA layout, and the gateway returns the JS-rendered desktop DOM from Camoufox.

## Goals

- Serve Google results in SearXNG through the gateway's `POST /content`.
- Need no gateway change. The gateway chooses its `google` profile from the hostname.
- Keep the engine and its tests in this repo, next to the gateway it calls.

## Non-goals

- Owning the SearXNG deployment. `openclaw-setup` keeps the manifests and the deploy script.
- Paging. The engine sets `paging = False`.

## Design

The engine is `integrations/searxng/stealth_google.py`, a SearXNG online engine.

- Request: `POST {STEALTH_BROWSER_URL}/content` with `Authorization: Bearer {STEALTH_BROWSER_TOKEN}` and body `{url, waitForTimeout}`. `url` is a Google search URL with `q`, `hl` and `num=10`. `waitForTimeout` is 2000 ms.
- Parse: results are `<a href="/goto...">` elements containing an `<h3>`. Google encrypts the real URLs behind these `/goto?url=` links.
- Resolve: each `/goto` link answers with a redirect whose `Location` header is the real URL. A plain curl confirmed this. The engine reads the header without following the redirect, for all results in parallel (8 workers, 5 s timeout each), through `searx.network.get(..., allow_redirects=False)`.
- Errors: `SearxEngineAPIException` when results exist but none resolve, and when the page is Google's redirect interstitial.
- Contract with the gateway: bearer auth, `{url, waitForTimeout}` in, rendered HTML out. The gateway solves any CAPTCHA before returning.

Tests live in `integrations/searxng/tests/` with a saved Google results page as a fixture. `conftest.py` stubs the SearXNG modules.

## Status

Built:

- the engine, with `/goto` resolution and the parallel resolver
- tests and a results fixture (9 passing)
- a regression test for a reserved name. A first deploy crash-looped because `network` is a reserved SearXNG engine name, and `test_module_does_not_shadow_reserved_engine_attributes` guards it. The engine imports `searx.network` as `searx_network`.
- manifests in `openclaw-setup` (ConfigMap, mount, env vars, Secret copy in `deploy.sh`, engine settings). The server-side dry run accepted them.

Not built or not working:

- The engine is not live. A session working in `openclaw-setup` on `feat/searxng-brave-api` edits the same manifests and applies them straight to the cluster. It overwrote the deploy, and the env vars, engine mount and `stealth google` entry were lost.
- The first live search after the second successful rollout returned "unexpected crash". It was not diagnosed.
- After a solved CAPTCHA the gateway can return Google's "click here if you are not redirected" page. See `stealth-browser-1uo`.

## Open items

- Rebase the `openclaw-setup` wiring onto `feat/searxng-brave-api` once it merges, redeploy, rerun the live search and diagnose the crash.
- Confirm SearXNG honors a 60 s per-engine timeout (`outgoing.max_request_timeout`). Solve latency was expected at 20 to 60 s.
- Throughput. The gateway's `google` profile paces requests 8 to 15 s apart, so concurrent searches may get 429 `queue_full`. Whether the engine should treat 429 as a soft failure is undecided.
- The plan proposed raising `SearxEngineCaptchaException` on a 423 `blocked` or a `/sorry` `X-Final-Url`. The engine does not do this. Whether it should is undecided.
- Confirm the engine module path in the SearXNG image. The deployment mounts at `/usr/local/searxng/searx/engines/`. The transcript does not show the `kubectl exec` check the plan called for.
- Run `python-reviewer` on the engine. The plan listed it, and the transcript does not show it.
- Fix the interstitial in the gateway (`stealth-browser-1uo`).

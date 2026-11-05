# SearXNG stealth google engine

`stealth_google.py` is a SearXNG online engine that gets Google web results through this gateway instead of letting SearXNG scrape Google with its own HTTP client.

## How it works

1. `request()` builds a Google search URL (`q`, `hl` from the SearXNG locale, `num=10`) and sends `POST {STEALTH_BROWSER_URL}/content` with a bearer token and the body `{"url": <google search url>, "waitForTimeout": 2000}`.
2. `response()` parses the JS-rendered desktop DOM the gateway returns. A result is an `<a href="/goto...">` that contains an `<h3>`. The title is the `<h3>` text, and the snippet is the text of the outermost ancestor (up to 5 levels) that holds only that one result, minus the title and `<cite>` text.
3. Google hides the real URLs behind `/goto` redirect links. The engine requests each one without following redirects and reads the `Location` header of the 301, 302, 303, 307 or 308 answer. It does this in parallel with 8 workers and a 5 s timeout per link. Duplicate URLs are dropped.

The engine raises `SearxEngineAPIException` when:

- results exist but none of the `/goto` links resolve
- the page has no results and contains Google's "Please click here if you are not redirected" interstitial
- the gateway body is empty or not parseable HTML
- `STEALTH_BROWSER_URL` or `STEALTH_BROWSER_TOKEN` is unset

A page with no results and no interstitial returns an empty result list and logs a warning with the page title and body length.

The gateway picks its `google` profile from the hostname, so the gateway needs no change for this engine.

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `STEALTH_BROWSER_URL` | Gateway base URL, no trailing slash | none, `request()` raises `SearxEngineAPIException` if unset |
| `STEALTH_BROWSER_TOKEN` | Bearer token for the gateway | none, same |

Engine settings entry:

```yaml
- name: stealth google
  engine: stealth_google
  shortcut: gg
  timeout: 60
```

## Tests

The tests stub the SearXNG modules in `tests/conftest.py`, so SearXNG itself is not needed. `lxml` is.

```sh
TERM=dumb uv run --with pytest --with pytest-timeout --with lxml python -m pytest --timeout=30 -p no:cacheprovider integrations/searxng/tests -q
```

## Deployment

The SearXNG manifests are in `deploy/k8s/searxng/`, next to the gateway's. Deploy with `deploy/k8s/searxng/deploy.sh` (add `--brave-key-file <path>` to set the Brave API key). The wiring for this engine:

- `kustomization.yaml`: a `configMapGenerator` entry `searxng-engines` built straight from `integrations/searxng/stealth_google.py`, so there is no second copy. It reaches outside the kustomization directory, so render with `kubectl kustomize --load-restrictor=LoadRestrictionsNone`, which `deploy.sh` does.
- `deployment.yaml`: mounts that ConfigMap at `/usr/local/searxng/searx/engines/stealth_google.py` with `subPath: stealth_google.py` (read-only), and sets `STEALTH_BROWSER_URL=http://gateway.stealth-browser.svc.cluster.local:8080` and `STEALTH_BROWSER_TOKEN` from key `token` of the Secret `searxng-gateway`.
- `configmap.yaml`: an `engines:` block in the SearXNG settings that disables the stock `google` engine and enables `stealth google` (`engine: stealth_google`, `shortcut: gg`, `timeout: 60`).
- `deploy.sh`: copies `gatewayToken` from the Secret `stealth-browser-secrets` in the `stealth-browser` namespace into the Secret `searxng-gateway` in the `searxng` namespace.

The OpenClaw side (registering SearXNG as a search provider) is configured in the `openclaw-setup` repo and is not part of this one.

## Known issues

1. After a solved CAPTCHA the gateway can return Google's redirect interstitial instead of results. The engine raises `SearxEngineAPIException` on that page. The gateway-side fix is tracked as `stealth-browser-1uo`.

Deployment status lives with the `openclaw-setup` wiring, not in this repo.

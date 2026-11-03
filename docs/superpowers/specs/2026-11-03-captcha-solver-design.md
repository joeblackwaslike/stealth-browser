# Gateway CAPTCHA solver and Google search

## Why

SearXNG on the Pi cluster (`openclaw-setup/k8s/searxng/`) loses its Google path on Jan 1. We want Google results to keep flowing through this gateway instead. Google will sometimes answer with its `/sorry/` reCAPTCHA page, so the gateway needs to solve challenges. Joe wants the solver available to every profile (eBay, Reddit, anon, google), not special-cased to Google. A paid third-party solving service is accepted.

This reverses the v1 non-goal "captcha-solving services" (`2026-10-16-stealth-browser-design.md`, line 45). Proxies stay a non-goal.

## Goals

- When a fetched page carries a solvable challenge and a solver is configured, the gateway solves it inside the same browser context and returns the real page.
- The solver is an interface. The first adapter speaks the 2Captcha API (CapMonster accepts the same format). Changing provider is a base URL and key change.
- Spend is capped per hour.
- A `google` profile paces Google requests separately from `anon`.

## Non-goals

- Proxies or IP rotation. Traffic still leaves from the home IP.
- Google results parsing in the gateway. The SearXNG engine parses (separate plan, openclaw-setup repo).
- Turning solving on for eBay or Reddit logins. The path is generic, but only enabled by config.

## Anti-goals

- Burning money silently. A capped, logged solver only.
- Bypassing the 30-minute block pause. A failed or refused solve must still end in the existing `blocked` verdict and pause.

## Approaches

- Chosen: the browser layer solves in place. After navigation it calls `detectChallenge`, asks the `Solver` for a token, injects it, submits, and re-reads the page. `app.ts` classification runs afterward unchanged, so every failure path is the existing one.
- Rejected: solving in `app.ts` after the fetch returns. The browser context is already closed by then, and a token is bound to the live page.
- Rejected: Google parser endpoint in the gateway. Breaks the no-per-site-parsers rule.

## Design

- `src/detect.ts` gains `detectChallenge(html, finalUrl): Challenge | null`, pure. First type is reCAPTCHA v2, including Google's `/sorry/` form (sitekey from `data-sitekey`, `data-s` from the same element).
- `src/solver/` holds the `Solver` interface, the 2Captcha adapter, and a per-hour budget wrapper.
- `src/browser.ts`: `FetchRequest` gains `solver?: Solver`. After `waitForTimeout`, if a challenge is detected and a solver is present, solve once, write the token into `#g-recaptcha-response`, submit the enclosing form, wait for navigation, then read `page.content()`. Any solver error is swallowed into "return the original page", which the classifier then marks blocked.
- `src/profiles.ts`: `google` profile, domain `google.com`, gap 8000-15000 ms, no login. (My call.)
- `src/config.ts`: `SOLVER_API_KEY` (optional), `SOLVER_BASE_URL` (default `https://2captcha.com`), `SOLVER_MAX_PER_HOUR` (default 20, my call). No key means no solver.
- The camoufox request deadline grows by the solver timeout when a solver is present.

## Risks

- Whether solver services accept Google's `/sorry` flow is undocumented. The last task is a live check, and it needs Joe's 2Captcha account key (an account and payment step only a human can do).
- Solve latency of 20-60s on human-backed services. The default deadline accounts for it.
- Google's terms restrict automated querying. Accepted; noted in the README.

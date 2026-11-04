# Per-host config, solve by default, HTML on every block

Status: draft for review. Bead: stealth-browser-s4k. Follows the CAPTCHA solver
([spec](2026-11-03-captcha-solver-design.md)) and the v1 gateway
([spec](2026-10-16-stealth-browser-design.md)).

## Why

On 2026-11-03 a fetch of mercari.com came back `423 { reason: "captcha" }` and
paused the `anon` profile for 30 minutes.

- The page was real content. A regex took the hidden `g-recaptcha-response` textarea
  of an invisible reCAPTCHA for a CAPTCHA widget (fixed in PR 6).
- The 423 gave no HTML and no matched marker, so finding the cause meant reading
  `/state/captures` inside the pod.
- The pause is per profile and `anon` covers every host that is not eBay, Reddit or
  Google, so one site's false block stopped fetching from all of them.

The gateway can now solve a reCAPTCHA. It should not treat a CAPTCHA it can solve as
a block, and it should not pause a profile for one. Configuration also lives in too
many places: pacing per profile, solver gating per profile, pause per profile.

## Goals

- One table, keyed by host, holds everything that varies by site.
- The solver is on whenever `SOLVER_API_KEY` is set. No per-profile gating.
- A page is blocked only when a challenge went unsolved, or when it shows a marker
  with no solver path (interruption page, "verify you are human", eBay redirect,
  HTTP 403).
- Every 423 that follows a fetch carries the page HTML, the matched marker and the
  capture filename.
- Every setting is documented in one README table.

## Non-goals

- Turnstile and hCaptcha solving (Turnstile is stealth-browser-y8r, paused).
- The dashboard (stealth-browser-82l). This spec only fixes the event field names it
  will read.
- Proxies, durable budget storage, new hosts beyond the four below.

## Anti-goals

- The solver filling and submitting a form that belongs to the page's content
  (signup, comment, contact). That is acting as the operator.
- A pause that stops fetching from hosts unrelated to the one that blocked.
- A 423 that hides what was on the page.

## Approaches

- A (chosen). Host table replaces profile config, plus a challenge-form guard.
  Pacing, pause policy and login state attach to a host entry. The solver runs on any
  host, but only on forms that are challenge forms.
- B. Keep profiles, change only the block and pause rules. Smaller, but leaves the
  per-profile settings that were the complaint.
- C. A `solve` flag on each request. Explicit and needs no form heuristic, but every
  caller (ai-listings, the web-research skill, SearXNG) would have to set it.

## Design

### Host table

A single module (replacing the settings part of `src/profiles.ts`) exports a table of
entries. An entry has a registrable domain, `minGapMs`, `pauseOnFailedSolve`, and
whether it keeps a saved login.

| Host | Gap | Pause after an unsolved block | Saved login |
| --- | --- | --- | --- |
| ebay.com | 20-40 s | yes | yes |
| reddit.com | 5-10 s | yes | yes |
| google.com | 8-15 s | no | no |
| everything else | 3-8 s | no | no |

A URL matches an entry by domain or any parent domain, on label boundaries (existing
behavior). Pacing and pauses are tracked per matched entry. A host with no entry uses
the default row, but is tracked under its own hostname, so two unknown sites never
gate each other. The `profile` field in requests and responses keeps its shape; its
value is the matched entry's name (`ebay`, `reddit`, `google`, otherwise `anon`).
Saved logins (`ebay.json`, `reddit.json`) are unchanged.

### Solver on by default

`SOLVER_PROFILES` is removed. With `SOLVER_API_KEY` set, any fetch that lands on a
challenge form is solved once, then the resulting page is re-read. Without a key,
nothing is solved and behavior is as today minus the false positive.
`SOLVER_MAX_PER_HOUR` rises from 20 to 100. The budget stays in memory, counts failed
attempts, and resets on restart.

### Challenge-form guard

The solver only acts when the form around the widget has no field a person would fill
in. Allowed inside the form: hidden inputs, submit and button inputs, and the
`g-recaptcha-response` textarea. Any visible text, email, password, search, tel, url,
number or date input, any other textarea, any select, and any checkbox or radio makes
it a content form. A widget in a content form is never solved and never counts as a
block; the page is returned as it is. Google's `/sorry` form passes. A signup form
with a reCAPTCHA does not.

The guard covers reCAPTCHA v2 only, the one widget the gateway can solve. A widget
with no enclosing `<form>` has nothing to fill or submit, so it is treated as content:
not solved, not a block. hCaptcha and Amazon's `captchacharacters` page have no
solver, so they stay unconditional blocks as today.

### What counts as blocked

1. A reCAPTCHA challenge form that is still unsolved when the fetch ends: the solve
   failed, the budget was spent, the widget has no sitekey, or no key is configured.
   Reason `captcha` (or `google_sorry` on Google's `/sorry` path, unchanged). This
   holds on every host, including eBay and Reddit, where the first solve attempt is
   made and the pause follows a failure.
2. Markers with no solver path: interruption title, "verify you are human", eBay
   `splashui/challenge` and error pages, HTTP 403. Unchanged.

A widget on its own, a response textarea, or a widget in a content form is not a
block. `429` stays `rate_limited` and never pauses.

### Pause

After a block (either kind above), the matched entry is paused for 30 minutes only if
its `pauseOnFailedSolve` is set: eBay and Reddit. The reason is that a challenge
retried from the home IP can flag a logged-in account. Every other host answers the
next request normally. A request that arrives during a pause still gets
`423 { reason: "paused" }` with `Retry-After`.

### Block response

`423` keeps its JSON body and gains fields:

```json
{ "blocked": true, "profile": "anon", "host": "example.com", "reason": "captcha",
  "marker": "captcha_widget:g-recaptcha", "html": "<html>…", "capture": "anon-blocked-….html" }
```

`marker` names the rule that matched, from a fixed list: `captcha_widget:g-recaptcha`,
`captcha_widget:h-captcha`, `captcha_widget:amazon`, `google_sorry`,
`interruption_page`, `verify_human`, `ebay_challenge_redirect`, `ebay_error_page`,
`http_block_status`. `html` is the page after the last solve attempt, or as first
read if none was made, in full and unredacted. `capture` is the file saved in
`/state/captures`; the capture store returns its name, and the field is omitted if
the write failed. The `paused` 423 has no `html` because no fetch happened.

### Events

Each fetch logs one line, and each solve attempt logs one, with fixed field names so
the dashboard can read them: `host`, `entry`, `verdict`, `status`, `ms`, `marker`,
`solve` (`solved`, `failed`, `skipped`), `solveReason`, `challengeType`, `attempts`.

### Documentation

The README gets a Configuration section with a table of every environment variable
(`GATEWAY_TOKEN`, `CAMOUFOX_WS_URL`, `STATE_DIR`, `PORT`, `LOG_LEVEL`,
`SOLVER_API_KEY`, `SOLVER_BASE_URL`, `SOLVER_MAX_PER_HOUR`), each with default and
effect, plus the host table. The deploy manifest drops `SOLVER_PROFILES`. The 423
body is documented in the README and in the clients that parse it (`ai-listings`
reprice command, `agent-skills` web-research `stealth-browser.md`).

## Testing

Fixture-based, written first:

- Google `/sorry` form is solved and returns content; the same with the solver absent
  returns 423 with `html` and `marker`.
- A signup form with a widget is returned as `200` and the solver is never called.
- Mercari's invisible reCAPTCHA page is `200`.
- An unsolved challenge on `anon` returns 423 and the next request is not paused;
  the same on eBay pauses.
- Two unknown hosts do not share a gap or a pause; a block on one leaves the other
  fetchable.
- The budget defaults to 100 and a removed `SOLVER_PROFILES` in the environment is
  ignored.

## Left to the builder

Exact visibility rules for the guard, the layout of the host module, and how the
scheduler keys its maps by entry or hostname. The guard needs the form's structure, so
it either runs in the page (the fetch result then carries a `challengeForm` flag the
classifier reads) or on the serialized HTML; pick whichever keeps `classifyPage`
testable against fixture HTML.

## Calls made for review

- eBay and Reddit pause after any unsolved block, not only after a CAPTCHA failure,
  since the protection is for the logged-in account.
- The 423 stays JSON with extra fields, not raw HTML, so existing callers keep working.
- The `profile` field stays, with the same four values.
- Pacing for hosts with no entry is per hostname.
- The budget stays in memory; durable counts belong to the dashboard work.
- The guard applies to reCAPTCHA v2 only; hCaptcha and Amazon stay blocks.
- A reCAPTCHA widget outside any form is content, not a challenge.
- Solving is attempted on eBay and Reddit. A spent budget, a missing sitekey, or no key
  leave a challenge unsolved, which blocks (and pauses eBay and Reddit).
- The 423 returns full, unredacted HTML, including for eBay and Reddit. The caller
  already holds the gateway token and could fetch the same page. Callers that feed an
  LLM should extract what they need (with `jq`) and not print the body.

## Risks

- Google `/sorry` no longer pauses. An unsolved one is retried on the next request
  from the home IP, bounded only by the 100-per-hour solver budget. If Google starts
  flagging the IP, set `pauseOnFailedSolve` on the google entry; it is one table row.
- Solving on every host spends money wherever a challenge form appears. The budget
  caps the spend; the dashboard will show it.

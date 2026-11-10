# porthole HTTP API (v1)

Served by the daemon on two listeners (see `docs/architecture.md`):

- **A** (remote viewers, via `tailscale serve` only): `https://<fqdn>:7443/`. Requires `Tailscale-User-Login` = owner.
- **B** (the Mac mini itself): `http://localhost:7444/`. Viewer is "local", so localhost URLs are primary.

Same routes on both. No CORS headers, OPTIONS → 405, unknown Host → 421.

## `GET /`

The launcher page (`web/index.html`). The server replaces `__PORTHOLE_CSRF__` in the HTML with the per-daemon-start CSRF token (`<meta name="porthole-csrf" content="__PORTHOLE_CSRF__">`). Static assets are served from `/static/<file>` (`web/<file>`), plus `/manifest.webmanifest` and `/apple-touch-icon.png`.

## `GET /api/services[?fresh=1]`

Answers from the last completed scan (never waits), except `?fresh=1` (the Retry button), which waits up to 3s for a new scan.

```jsonc
{
  "host": "mac-mini",
  "fqdn": "mac-mini.tail0a1b2c.ts.net",
  "viewer": "remote",            // "remote" (listener A) | "local" (listener B)
  "scannedAt": 1791484200000,    // ms epoch of the snapshot; null before the first scan
  "verifiedAt": 1791484200000,
  "scanning": false,             // true only on cold start (no snapshot yet): show "Scanning…"
  "stale": false,                // last scan failed, or snapshot older than 90s: show the stale banner
  "error": null,                 // last scan error text, when stale because of a failure
  "warnings": [{ "source": "docker", "message": "docker unavailable: containers shown by port only" }],
  "csrf": "…",                   // current CSRF token (refreshes the page's copy after a daemon restart)
  "overridesEtag": "\"3f2a\"",   // send as If-Match on PUT /api/overrides
  "services": [ServiceView, …]
}
```

`ServiceView` (TypeScript source of truth: `src/select.ts`):

| field | meaning |
|---|---|
| `key` | stable identity key; use it for overrides |
| `name` | display name (user rename applied) ; `derivedName` is porthole's own |
| `group` | project group heading (git main-worktree dir, compose project, "Services", "Other") |
| `project`, `branch`, `worktree` | git context; `worktree` is set only for a non-main worktree (show a branch chip) |
| `kind` | `docker` \| `launchd` \| `git` \| `serve` \| `port` |
| `container`, `launchdLabel` | when known |
| `pinned` | show as a launch tile |
| `hidden` | reason string when hidden (by rule or `"hidden by you"`), else `null`. Hidden services are excluded from the main list and search unless "search hidden too" is on, and are listed in the inspectable hidden list |
| `state` | `verified` \| `inferred` \| `blocked` \| `not_responding` \| `no_route` \| `identifying` \| `not_running` |
| `url` | the link to open in a new tab. Set **only** for `verified` / `inferred` |
| `label` | short route label: `"serve :6006"`, `"mac-mini:8844"`, `"localhost:5173"`, `"/rc"` |
| `caveat` | for openable rows: pill text (`"sign-in required"`, `"certificate expired"`, `"answers, but / is 404 …"`) |
| `reason` | for non-openable rows: why (`"::1 only, not served"`, `"not the app: Vite asset server"`, `"not running"`) |
| `fix` | `{ title, commands: [{label, cmd}], notes: [string] }` or null. Shown in the inline expand of non-openable rows (copy buttons per command) |
| `checkedAt` | when the chosen route was verified (ms) → "reachable from mac-mini 2m ago" |
| `lastSeen` | for `not_running` pinned tiles |
| `routes` | every candidate for this viewer, best first: `{url, label, state, caveat, kind}` (ⓘ sheet "other URLs") |
| `localUrl` | remote viewer: the URL that works on the Mac mini ("on the Mac mini") |
| `fallbackUrl` | Tailscale IPv4 URL for devices without MagicDNS |
| `ports` | `[{port, pid, process, binds:[…], title, scheme, probe, status}]` (ⓘ sheet "bindings") |
| `pid`, `command`, `cwd` | process facts (ⓘ sheet) |

Samples generated from the 2026-10-08 fixtures: `test/fixtures/api-services.remote.json`, `test/fixtures/api-services.local.json`.

## `PUT /api/overrides`

Edits porthole's own settings for one service. Gates: Host allowlist, owner (listener A), `Origin` = this listener's origin, `Content-Type: application/json`, `X-Porthole-CSRF: <token>`, `If-Match: <overridesEtag>`. Body ≤ 64KB.

```jsonc
// request
{ "key": "mac-mini/docker:open-webui-hermes", "set": { "pin": true } }
// set fields: pin: boolean | null, rename: string | null, hide: boolean | null   (null clears the field)
// response 200
{ "etag": "\"41ab\"" }
```

| status | meaning | client should |
|---|---|---|
| 200 | saved | store the new etag, refetch `/api/services` |
| 400 | body invalid | show the error |
| 403 | CSRF/Origin/owner rejected | refetch `/api/services` (new `csrf`), retry once |
| 409 | etag mismatch: changed elsewhere | show "changed elsewhere", refetch |
| 415 | not JSON | — |

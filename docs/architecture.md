# Architecture

This is a contributor's map of porthole: what each stage does, which module owns it, and why it works this way. The code and tests are the reference. This document explains them.

## Overview

```
 launchd LaunchAgent dev.porthole.daemon (KeepAlive, absolute binary paths)
        │
        ▼
 porthole daemon (Bun)
  ├─ listener A  127.0.0.1:<portA>  ◄── tailscale serve only
  │     https://<host>.<tailnet>.ts.net:7443/  porthole's origin (UI + API)
  │     https://<host>.<tailnet>.ts.net/       ":443 /" → 302 to the origin above
  ├─ listener B  127.0.0.1:7444     ◄── the Mac's own browser, http://localhost:7444/
  │
  ├─ scan loop: collect → deny → probe → aggregate → candidates → verify → snapshot
  ├─ snapshot (viewer-independent) → per-request route selection by viewer
  └─ ~/.config/porthole/{config,overrides,state,serve-backup}.json
```

## Pipeline

| Stage | Module | What it does |
|---|---|---|
| Collect | `src/collect/live.ts`, `src/collect/parse.ts` | Runs `lsof -F`, `ps`, cwd and git lookups, `launchctl list`, `docker ps`, and `tailscale status` / `serve status --json`. The parsers are pure functions, so the fixtures exercise exactly what the daemon runs. |
| Deny | `src/deny.ts` | Hides known non-web listeners before any request is sent to them. |
| Probe | `src/probe.ts`, `src/signatures.ts` | Identity probe per listener: scheme, status, `<title>`, favicon, and "not the app" signatures. |
| Aggregate | `src/aggregate.ts` | Merges bindings into listeners and listeners into services. Picks the identity port, key, name and group. |
| Candidates | `src/candidates.ts` | Builds the candidate URLs for both viewers from the bind address, the serve config and the probe scheme. |
| Verify | `src/verify.ts` | Fetches each candidate from the Mac and maps the outcome to a route state. |
| Resolve | `src/resolve.ts` | Glues aggregate, candidates and verify together. Adds rows for dead serve mappings and applies the "not the app" override. |
| Fixes | `src/fixes.ts` | Generates fix commands for rows that can't be opened. |
| Scan loop | `src/scanner.ts` | Cadence, probe cache and backoff, verification scheduling, and the snapshot. |
| Select | `src/select.ts` | Pure function of (snapshot, viewer, overrides) → the `ServiceView[]` the page renders. |
| Serve | `src/server.ts` | The two listeners, the gates, `GET /api/services` and `PUT /api/overrides`. |
| Persist | `src/config.ts`, `src/overrides.ts`, `src/state.ts` | Config, overrides with etag, and remembered names and last-seen times. All writes are atomic. |
| Install | `src/setup.ts` | `setup` / `teardown` / `status`, with system calls behind a `Sys` interface the tests fake. |
| Exec | `src/exec.ts` | Runs a command by absolute path with a timeout. Never uses a shell. Sets `TERM` and `LC_ALL`. |

### Freshness

- The daemon scans every 10s while a client has called `/api/services` in the last 60s, and every 60s otherwise.
- Requests never wait for a scan. They get the last completed snapshot. The one exception is `?fresh=1` (the Retry button), which waits up to 3s.
- A request that finds the snapshot older than 15s starts a rescan in the background.
- Identity probes run at most 8 at a time, with a 1.5s timeout each and a 3s budget per scan. Probes that miss the budget finish and land in the next scan.
- Full re-verification runs when the listener set, the probe schemes or the serve config change, and every 60s while a client is active. Otherwise only new candidates are verified, so idle dev servers aren't hit once a minute around the clock.
- The page shows a stale banner when the last scan failed or the snapshot is older than 90s. That's above the idle interval plus the scan budget, so an idle period alone doesn't trigger it.
- Each collector fails on its own and produces a warning (for example "docker unavailable: containers shown by port only"). Only an `lsof` failure fails the whole scan.

### Identity probe

- The probe sends a plain HTTP `GET /` first. If that gets a TLS-style failure, or a 400 saying an HTTP request reached an HTTPS port, it retries over HTTPS with certificate checks off.
- A probe succeeds on any response below 500. Successes are cached per (pid, port, process start time) until the listener disappears.
- Failures (5xx, timeouts, refusals) are retried on the next scan, then after 30s and 2m, then every 10m. That covers a dev server that is still compiling, or recovering from an error, without a restart. Once retries reach the 10-minute cadence, the listener counts as "no HTTP response".
- A listener gets no direct candidate until its scheme is known.
- When a serve mapping points at a path on the listener, the probe uses that path instead of `/`.

## Two listeners

**Listener A (remote).** `tailscale serve` is its only client.

- Its loopback port is picked once by `setup` and saved in `config.json`, because serve mappings point at it.
- `Host: <fqdn>` (from `:443 /`) gets a 302 to `https://<fqdn>:7443/` and nothing else.
- `Host: <fqdn>:7443` gets the UI and API. Any other Host gets 421.
- Every request needs `Tailscale-User-Login` to equal the owner, otherwise 403. The owner comes from `tailscale status`, or from `config.owner` on a tagged node. Until the owner is known, the listener answers 503, because an empty owner must never match.
- The viewer is "remote".

**Listener B (local).** The Mac's own browser.

- Allowed hosts are `localhost:7444` and `127.0.0.1:7444`.
- Identity headers are ignored.
- The viewer is "local", so `localhost` URLs rank first.
- A PUT still needs B's own Origin and the CSRF token.

Both listeners serve the same routes:

- `GET /` returns the page, with the CSRF token substituted in.
- `GET /api/services` returns the services. See [api.md](api.md).
- `PUT /api/overrides` saves an override. It needs the listener's Origin, a JSON content type, `X-Porthole-CSRF` and `If-Match`, and the body is capped at 64 KB.
- Static files come from `web/`. Plain filenames only, no `.ts` files.

The viewer is decided by which listener received the request, never by `X-Forwarded-For`.

## Candidates

**Remote viewer:**

| Bind or mapping | Candidate | Kind |
|---|---|---|
| `127.0.0.1:P` or `[::1]:P` only | none directly, only through a matching serve mapping | |
| `0.0.0.0:P` or `*:P` (IPv4) | `<scheme>://<host>:P` (MagicDNS short name) | `direct` |
| `*:P` (IPv6 wildcard) | `<scheme>://<host>:P` and `<scheme>://[fd7a:…]:P`, and verification chooses | `direct` |
| Tailscale IPv4 `100.x:P` | `<scheme>://<host>:P` | `direct` |
| Tailscale IPv6 | `<scheme>://[fd7a:…]:P` | `direct` |
| serve HTTPS port S, path p | `https://<fqdn>[:S]p` | `serve_https` |
| serve HTTP port S, path p | `http://<host>:S` + p | `serve_http` |

**Local viewer:**

| Bind or mapping | Candidate |
|---|---|
| loopback or wildcard | `<scheme>://localhost:P`, plus the upstream path for path-mounted serve mappings |
| Tailscale IP only | the remote direct candidate |
| any serve mapping | the serve URL, same as remote |

**Matching serve upstreams to listeners:**

- `127.0.0.1:P` matches a v4 loopback or a wildcard listener.
- `::1:P` matches a v6 loopback or a v6 wildcard listener.
- `localhost:P` matches either.
- If the port is right but the address family is wrong (a v4 upstream with a `::1`-only listener), the candidate is marked blocked before any fetch.

A serve mapping whose loopback upstream has no listener in either family becomes its own `serve`-kind row, in state not responding.

## Verification

The daemon fetches the exact candidate URL from the Mac itself. Hairpin fetches through serve and the MagicDNS name work from the Mac.

- **localhost candidates** are fetched on `127.0.0.1` and then `[::1]`, with `Host: localhost:P`, the way browsers try both.
- **Redirects** are followed up to 3 hops while they stay on this host: the short name, the FQDN or a Tailscale IP.
- **HTTPS** is fetched with certificate checks off so porthole can read the response. Whether the certificate validated is recorded separately.

The outcome table is total. It is checked top to bottom, and the first match wins (`classify()` in `src/verify.ts`):

| Check | State | Caveat or reason |
|---|---|---|
| serve upstream address family doesn't match the listener (known before fetching) | blocked | "serve points at 127.0.0.1:P, app is on ::1" |
| refused, timeout, reset, or a TLS failure other than certificate validation | not responding | "not responding" |
| serve candidate answers 502/503/504 and no listener exists on the upstream port | not responding | "serve can't reach 127.0.0.1:P" |
| body or title matches a signature (Vite "Blocked request", "Invalid Host header", a Vite asset-server placeholder) | blocked, port excluded | "host not allowed" / "not the app: …" |
| redirect to loopback | blocked | "redirects to localhost" |
| certificate failed validation | inferred | "self-signed certificate", "certificate expired", … |
| redirect to another host, or more than 3 redirects | inferred | "redirects to <host>" / "too many redirects" |
| 2xx | verified | |
| 401 | verified | "sign-in required" |
| 403 with no signature | verified | |
| 404 | inferred | "answers, but / is 404 (API or path-mounted)" |
| 426 | inferred, port excluded | "websocket-only port" |
| other 4xx | inferred | "answers <status>" |
| serve 502 with a live upstream | inferred | "serve can't proxy to …" |
| other 5xx | inferred | "<status>: app error" |
| no candidate for this viewer | no route | from the bind, e.g. "::1 only, not served" |

When the loopback identity probe matched a "not the app" signature, every route to that port is blocked, whatever the tailnet fetch returned. Verified means "reachable from this Mac". porthole can't prove that the viewer's device can reach the URL, because of ACLs and device DNS.

## Ranking per viewer

`rank()` in `src/select.ts` orders routes by state first, then by kind:

- **State:** verified > inferred > blocked > not responding > no route.
- **Kind, remote viewer:** `serve_https` > `direct` > `serve_http` > `localhost`.
- **Kind, local viewer:** `localhost` > `serve_https` > `direct` > `serve_http`.

Ties go to the lower port. A service's link is its best route, leaving out excluded ports (signature matches and 426). If every port is excluded, the best excluded route is used, so the row still shows a state, a reason and a fix. Only verified and inferred rows get a `url`.

On the remote view, a service's best openable `localhost` route appears as `localUrl` in the details sheet. It is never the main link there.

## Service grouping and identity

Bindings of the same (pid, port) merge into one listener. Listeners join into one service only on positive evidence:

- they are ports of the same Docker container (matched through `docker ps` publications, never through the proxy pid);
- they share a pid;
- they share a port, as nginx-style worker pools do;
- they are siblings under the same `npm|bun|pnpm|yarn run` parent in the same cwd, and the extra port has no page of its own.

Otherwise, separate processes are separate services.

**The identity port** supplies the key and the name. It is the lowest-numbered port with a title, or else the lowest port. Route state and viewer never enter into it, so a flapping verification can't rename or unpin a service.

**The key** is `<host>/` followed by the first of these that applies:

1. `docker:<container name>`
2. `launchd:<job label>`, except per-launch `application.*` labels, which aren't stable
3. `git:<main worktree>[#<linked worktree>]:<launcher>[@<cwd relative to the worktree>]`, for example `git:~/code/shop#~/code/shop.worktrees/feature-x:vite@apps/web`. The launcher is one of these, in order:
   - the script or module an interpreter runs (`vite`, `storybook`, `next`);
   - the process name without its version;
   - the parent `npm run` script.
4. `serve:<port><path>`, for a serve mapping with nothing listening
5. `port:<port>`, as a last resort

Ports and pids are not part of keys 1 to 4. A dev server that restarts or moves from `:5173` to `:5174` keeps its pins and renames. If a key matches several live services, an override applies to all of them.

- **Name:** the title, or else the container name, the launchd label, the launcher, and finally `:port`.
- **Group:** for git services, the main worktree's directory name. For containers, the compose project or the container name. For other launchd jobs, "Services". Everything else goes in "Other".
- Git context ignores Homebrew's own checkout, so Homebrew-managed services don't group as a project.

## Overrides

`overrides.json` is `{ version: 1, services: { <key>: { pin?, rename?, hide? } } }`.

- `PUT /api/overrides` takes `{ key, set }` patches. A `null` value clears a field.
- `hide: false` overrides a hide rule, so you can show something porthole hid.
- Writes go through a temp file and a rename. The etag is a hash of the file. The store re-reads the file when it changes on disk, so hand edits work.

`state.json` stores the last name, group, URL and last-seen time for each key. A pinned service that isn't running then still shows as a dimmed tile with a name, even after a daemon restart.

## Deny rules

`src/deny.ts` runs before probing. No request is ever sent to a listener a rule matches. Each rule's reason appears in the inspectable hidden list. The rules cover:

- porthole itself;
- macOS system services;
- databases and other non-HTTP servers, matched by process name and by well-known port (Postgres, Redis, MySQL, MongoDB, SMTP, Syncthing);
- editor and IDE helpers;
- Python multiprocessing workers;
- OrbStack or Docker proxy ports that match no container.

The OrbStack rule applies only after a successful `docker ps`. When docker fails, those ports are shown by number under the warning.

After probing, `aggregate.ts` also hides:

- services whose ports never answer HTTP ("no HTTP response");
- services that answer with neither HTML nor a title ("no page (API)"). A service with a serve route is never hidden this way.

Hidden services get no generated fixes. porthole won't suggest exposing something it hid.

## Setup and teardown

`setup` is idempotent:

1. Checks that the required binaries exist. Docker is optional.
2. Reads the FQDN from `tailscale status`.
3. Refuses if `:7443` is used by another serve mapping or a foreign process, or if `:7444` is taken.
4. Keeps listener A's port from the config if it's still free or already porthole's, and otherwise picks a free one.
5. Writes `config.json`, installs the LaunchAgent and waits for the daemon to answer on listener B. If it doesn't answer, setup stops before touching serve.
6. Backs up `tailscale serve status --json` to `serve-backup.json`, but only if no backup exists and `:443 /` doesn't already point at porthole. A re-run therefore never overwrites the original target.
7. Adds `--https=7443` → listener A, and, unless `--keep-root` is given, `--https=443 --set-path=/` → listener A.
8. Compares the serve config before and after, and fails if any other handler changed.

`teardown`:

1. Boots out the LaunchAgent and removes its plist.
2. Removes the `:7443` mapping if it points at porthole.
3. Handles `:443 /` from the backup:
   - If `/` no longer points at porthole, it leaves it alone.
   - If the backed-up target is still listening, it restores it.
   - If the target is gone, or there was no `/` handler before, it removes `/`.
   - If there's no backup, it leaves `/` alone.
4. Renames the backup to `serve-backup.<timestamp>.json`, so the next `setup` takes a fresh one.

Config, overrides and state are kept. The tests cover setup → teardown → repoint `/` → setup → teardown, and check that the second teardown restores the new target.

## Key decisions

- **Discovery, not registration.** Everything comes from the system. Config holds only overrides, so new dev servers appear without any setup.
- **Verify, don't guess.** Binds plus serve config only produce *candidate* URLs. Host checks, HTTPS and path mounts break plenty of them. Fetching the exact URL is what makes a link trustworthy, and caveats keep partially working routes openable.
- **A dedicated origin for porthole.** Path-mounting the UI under `:443` would share an origin with every other app mounted there, and their scripts could read porthole's pages and CSRF token. `:443 /` only redirects.
- **Owner identity from serve, not a password.** The tailnet already authenticates the device and user, and serve's identity header can't be spoofed by clients. Binding only to loopback makes serve the only way in.
- **Plain-HTTP candidates never use the FQDN.** HSTS applies per host across all ports. One HTTPS service sending `Strict-Transport-Security` on the FQDN would break every `http://<fqdn>:P` link, so plain HTTP uses the short name.
- **The snapshot is viewer-independent.** Route selection is a pure function computed per request, so both listeners share one scan, and selection is easy to test.
- **Stable identity ignores route state.** Keys and names come from facts that don't flap, which keeps pins and renames attached.
- **Deny before probe.** porthole never sends HTTP to a database or a helper socket.
- **Never suggest `0.0.0.0`.** Generated fixes use `tailscale serve` or the Tailscale IP. A wildcard bind would expose the server on every network the Mac joins.
- **Absolute paths and `TERM` under launchd.** launchd's `PATH` lacks Homebrew, OrbStack and Bun. The Tailscale app's binary acts as a CLI only when `TERM` is set, so `exec.ts` defaults it to `dumb`.
- **One write endpoint.** The browser can change only porthole's own overrides. Anything that changes the machine, such as creating serve mappings or starting and stopping services, would need its own allowlisted, gated endpoint.
- **No framework, no build.** Bun runs the TypeScript directly, and the page is static HTML, CSS and JS that renders immediately and then polls `/api/services` every 5s while visible.

## Known limits

- Runs on macOS only.
- Shows only the current user's listeners, because `lsof` runs as that user.
- Running git in a cwd under a privacy-protected folder (Desktop, Documents, iCloud) can fail from a background agent. The service then shows without git context.
- One daemon per machine. The data model carries a `host` in every key, so merging several machines later isn't blocked.

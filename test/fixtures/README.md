# Fixtures

Captured on a Mac mini on 2026-10-08 by `scripts/capture-fixtures.sh`, then sanitized for
publishing: the tailnet name, Tailscale IPs, owner login, user name, home paths, project names,
process start times and long command-line flags were replaced with consistent fakes
(`mac-mini.tail0a1b2c.ts.net`, `100.101.102.103`, `alice@github`, `/Users/alice`, `acme-app`, …),
and unrelated `launchctl` entries were trimmed. Ports, pids, address families, serve mappings,
git/worktree layout and docker publications are as captured.

| Path | Context |
|---|---|
| `2026-10-08-interactive/` | interactive shell, full PATH (re-captured with `lsof -F t` so address family is recorded) |
| `2026-10-08-launchagent/` | throwaway LaunchAgent, launchd PATH `/usr/bin:/bin:/usr/sbin:/sbin`, absolute binary paths; captured before the `t` field was added |
| `2026-10-08-serve-headers.json` | what `tailscale serve` forwards to a loopback upstream (hairpin request from the mini) |

## What the captures settled

- **launchd parity.** Under the LaunchAgent, every source matched the interactive capture: 48 listener pids, `tailscale` CLI (GUI app binary), `docker` (OrbStack), git in all 20 repos with no TCC prompt, and every hairpin URL. Only timing and `sort` order differed (no `LANG` under launchd; the script now sorts with `LC_ALL=C`).
- **Hairpin works** from the mini to serve ports (`:6006`), serve paths (`/rc`), HTTP serve ports (`:4330`) and direct binds via the short name.
- **Serve headers** (`2026-10-08-serve-headers.json`):
  - `Host` arrives unchanged, port included (`mac-mini.tail0a1b2c.ts.net:7443`), so listener A can tell the `:443` stub from the `:7443` UI.
  - `X-Forwarded-For` is set (the client's Tailscale IP; here the mini's own, because of the hairpin), plus `X-Forwarded-Host` and `X-Forwarded-Proto: https`.
  - `Tailscale-User-Login` / `-Name` arrive. A client-sent `Tailscale-User-Login: evil@example.com` was replaced by the real identity.
- **Owner:** this node is user-owned (`Self.Tags: null`), so the owner login comes from `Self.UserID`.

## Cases the design did not anticipate

1. **Vite host check through the tailnet name.** `http://mac-mini:5174/` → **403** (Vite "Blocked request"), while `127.0.0.1:5174` showed the "Laravel Vite" placeholder. The blocked-host signature row is required, not hypothetical.
2. **TLS-only direct listener.** `http://mac-mini:8443/` → curl 52 "Empty reply from server": the scheme-detection signal for `:8443`.
3. **IPv6 wildcard binds differ.** `node *:3000` (IPv6) is dual-stack and answers on IPv4. `python3.13 *:57522` / `*:64766` (IPv6) are v6-only and refuse `mac-mini` over IPv4. `lsof` can't tell them apart, so for an IPv6 wildcard the resolver should emit `mac-mini:P` and the Tailscale IPv6 `[fd7a:…]:P`, and let verification choose.
4. **Homebrew is a git repo.** Redis and Meilisearch have cwds under `/opt/homebrew`, whose toplevel is a git checkout on branch `stable`. Git context should ignore toplevels outside the user's code (e.g. `/opt/homebrew`, `/usr/local/Homebrew`), or those services get grouped as a "homebrew" project.
5. **Python workers expose extra ports.** `task-runner` (two multiprocessing python workers) each bind an IPv4 and IPv6 wildcard port that answers 503 or refuses. They're internal worker ports and should land in the hidden list.

## Found after deployment

6. **The Tailscale CLI needs `TERM` under launchd.** `/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json` with no `TERM` in the environment prints "The Tailscale GUI failed to start …" instead of JSON. launchd sets no `TERM`, so `src/exec.ts` defaults it to `dumb`.

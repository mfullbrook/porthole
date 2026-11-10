# Security

## Reporting a vulnerability

Please report it privately. Open a GitHub security advisory on this repository: go to **Security**, then **Advisories**, then **Report a vulnerability** (<https://github.com/mfullbrook/porthole/security/advisories/new>). Don't open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker gains. This is a personal project, so responses are best effort.

## Threat model

porthole runs on a Mac and shows a page listing the web services on it, with links to open them from devices on the owner's Tailscale tailnet.

**What it protects:**

- The service inventory: process names, ports, command lines, working directories, git branches and container names. The page shows all of these.
- `overrides.json`, the only file the browser can change.

**Trust boundaries:**

- **The tailnet is the network boundary.** Both listeners bind `127.0.0.1`. Remote devices reach porthole only through `tailscale serve`, on a dedicated HTTPS origin (`:7443` by default) that serves nothing else, so pages from other apps on the same tailnet hostname can't read it.
- **Owner only on the tailnet.** The remote listener requires the `Tailscale-User-Login` header that serve injects to equal the machine's owner, taken from `tailscale status` or set in `config.json`. serve overwrites any value a client sends. Other users, shared-in users and tagged devices get 403. While the owner is unknown, the listener answers 503 rather than failing open.
- **Local processes are trusted.** Any process running as the user can connect to the loopback listeners and could forge the identity header on the remote listener. porthole doesn't defend against code already running as you.

**Controls:**

- A Host allowlist (421 otherwise) blocks DNS rebinding.
- porthole sends no CORS headers, and `OPTIONS` returns 405.
- Responses carry a strict CSP, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`.
- The one write endpoint, `PUT /api/overrides`, requires:
  - the listener's own `Origin`;
  - `Content-Type: application/json`;
  - a per-daemon-start CSRF token that only same-origin pages can read;
  - an `If-Match` etag.

  Bodies are capped at 64 KB and validated against a schema. Writes are atomic and the file is user-only (`0600`).
- External commands run by absolute path with an argument list, never through a shell. The browser can't trigger any command.
- Deny rules run before probing, so porthole never sends requests to databases or other known non-HTTP listeners.
- Generated fix suggestions never propose binding to `0.0.0.0` or a bare `--host`, which would expose a dev server on every network the Mac joins.

**Out of scope:**

- Devices on the tailnet that are compromised but logged in as the owner.
- Root-owned listeners, which porthole can't see anyway.
- The security of the services porthole links to. porthole only opens them, and a verified route means "reachable from this Mac", not "safe".

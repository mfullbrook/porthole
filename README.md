# porthole

A launcher page for the web apps running on your Mac, reachable from any device on your Tailscale tailnet.

`http://localhost:5173` is useless on your phone. A dev server bound to `0.0.0.0` works over the tailnet, but you have to remember which port it's on. One bound to `::1` doesn't work at all until you add a `tailscale serve` mapping. When you do, Vite may refuse the new hostname, and a few mappings later you've lost track of which URL goes with which app.

porthole runs as a small daemon on the Mac. It finds every listening port, works out what each one is and which URL actually opens it from the device you're holding, and checks that URL before showing it. You get one bookmark, `https://<host>.<tailnet>.ts.net/`. It opens a phone-friendly page where one tap opens any service in a new tab. When a service has no working route, the page says why and suggests a fix.

macOS only. Read-only towards your apps: the only thing the page can change is porthole's own pin, rename and hide settings.

## How it works

Each scan runs this pipeline:

1. **Collect.** `lsof` (every TCP listener), `ps` (command, parent, start time), cwd and git (project, branch, worktree), `launchctl list`, `docker ps`, `tailscale status --json` and `tailscale serve status --json`.
2. **Deny.** Databases, system daemons, editor helpers and other known non-web listeners are hidden before porthole sends them any request.
3. **Probe.** Each remaining listener gets one `GET /` over loopback to learn its scheme (HTTP or HTTPS), status and `<title>`.
4. **Aggregate.** Listeners are grouped into services (one per process, container or `npm run` script) and each service gets a stable identity key.
5. **Candidates.** From the bind address and the serve config, porthole lists every URL that could work: the serve URL, `http://<host>:PORT` for wildcard or Tailscale-IP binds, and `localhost` for viewers on the Mac itself.
6. **Verify.** porthole fetches each candidate URL from the Mac and classifies the result as verified, inferred (it opens, with a caveat), blocked, not responding or no route.
7. **Select.** On each request, porthole picks the best route for the viewer: a phone over the tailnet, or the Mac itself.

[docs/architecture.md](docs/architecture.md) has the details.

## Requirements

- macOS (it uses `lsof`, `launchctl` and a LaunchAgent).
- [Bun](https://bun.sh) 1.3 or later.
- The Tailscale macOS app, with MagicDNS and HTTPS certificates enabled for your tailnet (`tailscale serve --https` needs them). porthole calls the app's own binary at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- Optional: Docker or OrbStack, so containers are named and grouped. Without it, published ports still appear by number, with a warning.

## Install

```sh
git clone https://github.com/mfullbrook/porthole.git
cd porthole
bun install
bun link            # puts `porthole` on your PATH
porthole setup
```

Without `bun link`, run `bun src/cli.ts <command>` from the repo instead.

The LaunchAgent runs `src/cli.ts` from the directory you cloned into, using the Bun that ran `setup`. If you move the repo or reinstall Bun, run `porthole setup` again.

## Usage

```
porthole run                          run the daemon in the foreground (the LaunchAgent runs this)
porthole scan [--local] [--all] [--json]
porthole setup [--keep-root] [--dry-run]
porthole teardown [--dry-run]
porthole status
```

- **`run`** starts the daemon. Listener B (`http://localhost:7444/`) always starts. Listener A, the tailnet listener, starts only after `setup` has picked its port. `bun run dev` does the same as `porthole run`.
- **`scan`** runs one scan and prints a table: `✓` verified, `≈` inferred, `✕` not openable.
  - `--local` shows the routes as the Mac itself sees them. The default is the remote (tailnet) view.
  - `--all` includes hidden services and the reason each is hidden.
  - `--json` prints the same data the page gets (see [docs/api.md](docs/api.md)).
- **`setup`** installs the LaunchAgent and the `tailscale serve` mappings (details below). `--dry-run` prints the plan and changes nothing. `--keep-root` leaves `/` on `:443` alone.
- **`teardown`** reverses `setup`. `--dry-run` prints the plan.
- **`status`** shows the config, the listener ports, whether the LaunchAgent is installed, any serve backup, the current serve mappings (porthole's are marked) and whether the daemon answers.

## What `setup` changes

- Writes `~/.config/porthole/config.json` with the listener ports, your machine's MagicDNS name and absolute paths to `lsof`, `ps`, `git`, `launchctl`, `tailscale` and `docker`. launchd's `PATH` doesn't include Homebrew, OrbStack or Bun, so porthole always uses absolute paths. Edit `bins` in this file if a tool lives somewhere else.
- Installs and starts the LaunchAgent `dev.porthole.daemon` (`~/Library/LaunchAgents/dev.porthole.daemon.plist`, with `RunAtLoad` and `KeepAlive`), then waits for the daemon to answer.
- Adds a `tailscale serve` HTTPS mapping on `:7443` to porthole's tailnet listener. This is porthole's own origin, and nothing else is mounted on it.
- Repoints `/` on `:443` to porthole, which redirects it to `:7443`. Before the first change it saves your current serve config to `~/.config/porthole/serve-backup.json`. Use `--keep-root` to skip this step. porthole is then only at `https://<host>.<tailnet>.ts.net:7443/`.
- Checks afterwards that every other serve handler (other ports and paths) is unchanged.

setup refuses to run if `:7443` is already used by another serve mapping or a local process, or if `:7444` is taken. You can change `remotePort` and `localPort` in `config.json`. Running setup again is safe: it keeps the existing backup and listener port.

`porthole teardown` unloads the LaunchAgent and deletes its plist, then removes the `:7443` mapping. If `/` still points at porthole, it puts back the handler from the backup. If that target is no longer listening, or there was no `/` handler before, it removes `/` instead. If `/` was pointed somewhere else in the meantime, teardown leaves it alone. teardown then renames the backup to `serve-backup.<timestamp>.json`, so the next `setup` takes a fresh one. It keeps `config.json`, `overrides.json` and `state.json`.

## URLs

| Where | URL |
|---|---|
| Any tailnet device | `https://<host>.<tailnet>.ts.net/`, which redirects to `https://<host>.<tailnet>.ts.net:7443/` |
| The Mac itself | `http://localhost:7444/` |

For example, `https://mac-mini.tail0a1b2c.ts.net/`. The two entry points rank routes differently. On the tailnet page a service's link is a serve or tailnet URL, and its localhost URL appears in the details sheet only. On the Mac's own page, `localhost` links come first.

## Security model

- **Binds `127.0.0.1` only.** Nothing listens on your LAN or tailnet interfaces. Tailnet devices reach porthole only through `tailscale serve`.
- **Owner only.** On the tailnet listener, every request must carry a `Tailscale-User-Login` header equal to the machine's owner. serve injects this header and replaces any value a client sends. The owner comes from `tailscale status`. On a tagged node you can set it explicitly with `"owner"` in `config.json`. Requests from other users or tagged devices get 403. Until the owner is known, for example at boot before Tailscale connects, the listener answers 503.
- **Host allowlist.** Any `Host` other than porthole's own names gets 421, which blocks DNS rebinding. porthole sends no CORS headers, and `OPTIONS` returns 405.
- **One write endpoint.** `PUT /api/overrides` changes only porthole's `overrides.json`. It requires a matching `Origin`, `Content-Type: application/json`, a per-daemon-start CSRF token and an `If-Match` etag. Bodies are capped at 64 KB and validated.
- **Probes stay local.** porthole sends requests only to listeners on this Mac that survived the deny rules, and to the candidate URLs it builds for them.

Anything running as your user on the Mac can reach the loopback listeners, so porthole trusts local processes. See [SECURITY.md](SECURITY.md).

## iPhone and iPad

Open `https://<host>.<tailnet>.ts.net/` in Safari, tap Share, then **Add to Home Screen**, and turn **off** "Open as Web App". The icon then opens porthole in a normal Safari tab, and each service opens in a real new tab instead of an in-app view.

## Customizing

Tap ⓘ on any service to open its details sheet: other URLs, the localhost URL, the bindings, process and git facts. From there you can:

- **Pin**: show the service as a large tile at the top. A pinned service that isn't running stays as a dimmed tile showing when it was last seen.
- **Rename**: replace the derived name, which comes from the page title, container, launchd label, launcher or port.
- **Hide**: move the service to the hidden list. You can also un-hide something porthole hid by rule.

Settings are stored in `~/.config/porthole/overrides.json`, keyed by the service's identity rather than its port. They survive restarts, and they survive a dev server moving from `:5173` to `:5174`. Changes made on one device show up on the others.

On a desktop browser, search has focus on load (`/` focuses it again). Type to filter, use ↑/↓ to move, Enter to open, and `i` to open the details sheet.

## Troubleshooting

- **Logs:** `~/Library/Logs/porthole.log` (the LaunchAgent's stdout and stderr).
- **Restart the daemon:** `launchctl kickstart -k gui/$(id -u)/dev.porthole.daemon`
- **Check everything at once:** `porthole status`
- **See what porthole sees:** `porthole scan --all`, or `porthole scan --local`
- **Tailscale CLI errors under launchd:** the Tailscale app's binary behaves as a CLI only when `TERM` is set, and launchd sets none. Without `TERM` it tries to start the GUI and prints an error instead of JSON. porthole sets `TERM=dumb` for every command it runs, so you don't need to do anything. Keep this in mind if you call that binary from your own scripts.
- **"waiting for Tailscale" (503):** Tailscale isn't connected yet, or the node is tagged and has no owner. Set `"owner"` in `config.json` if the node is tagged.
- **A row says "host not allowed":** the dev server rejects the tailnet hostname. For Vite, add your host to `server.allowedHosts`. The row's fix shows the exact entry.
- **Only your user's listeners appear.** porthole runs `lsof` as you, so it can't see services running as root.

## Development

```sh
bun install
bun test              # unit and fixture tests
bun run typecheck     # tsc --noEmit
bun web/dev-server.ts # launcher page against sample data, on http://127.0.0.1:7499/
```

The dev server serves `web/` with the sample API responses in `test/fixtures/api-services.*.json`, so you can work on the page without the daemon. Options:

- `PORT=<n>` changes the port, and `PORTHOLE_VIEWER=local` changes the default viewer.
- Query parameters `?viewer=local|remote` and `?scenario=stale|scanning|warnings|none` pick the data. They're remembered in a cookie.
- `POST /dev/rotate-csrf` and `POST /dev/bump-etag` simulate a daemon restart and a concurrent edit.

The resolver tests run against fixtures captured from a real Mac with `scripts/capture-fixtures.sh`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [test/fixtures/README.md](test/fixtures/README.md).

To run a second daemon from a checkout next to the installed one, give it its own config directory and local port: `PORTHOLE_CONFIG_DIR=$(mktemp -d) PORTHOLE_LOCAL_PORT=7454 bun src/cli.ts run`. With a fresh config directory, listener A stays off. Only listener B starts, at `http://localhost:7454/`.

## License

[MIT](LICENSE)

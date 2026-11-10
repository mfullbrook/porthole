# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so we can agree on the approach.

## Setup

You need macOS and Bun 1.3 or later. The tests themselves don't touch the system.

```sh
bun install
bun test              # all tests: parsers, resolver, verification, server gates, setup/teardown
bun run typecheck     # tsc --noEmit (strict)
bun web/dev-server.ts # the launcher page against sample data, http://127.0.0.1:7499/
```

CI runs `bun run typecheck` and `bun test` on every push and pull request.

Read [docs/architecture.md](docs/architecture.md) before changing the resolver. The outcome table, the ranking and the identity keys are deliberate, and each has tests that pin it.

## Style

- TypeScript run directly by Bun, with no build step and no runtime dependencies.
- Two-space indent (see `.editorconfig`).
- Keep the pipeline stages pure where they are now (`collect/parse.ts`, `aggregate.ts`, `candidates.ts`, `verify.ts` `classify`, `select.ts`), so the fixtures can test them.
- External commands go through `src/exec.ts`: absolute paths, an argument list and no shell.
- The web page is plain HTML, CSS and JS in `web/`, with no framework.

## Fixtures

The resolver tests run against real collector output captured with `scripts/capture-fixtures.sh`:

```sh
scripts/capture-fixtures.sh test/fixtures/<date>-interactive
```

It records `lsof`, process facts with cwd and git, `tailscale serve status`, a reduced `tailscale status` (this node only), `docker ps`, `launchctl list` and hairpin fetches. Run it from an interactive shell. If you're changing anything launchd-sensitive, also run it from a throwaway LaunchAgent: `PATH`, `TERM` and privacy prompts differ there.

**Scrub captured fixtures before committing them.** A raw capture contains personal and machine data:

- your tailnet name and MagicDNS hostname;
- your Tailscale IPs;
- your Tailscale login;
- your username and home directory;
- project and repo names, branch names, page titles, container names and launchd labels;
- full command lines, which can include tokens or keys passed as arguments.

Replace them with neutral values before you commit. The existing fixtures use `mac-mini.tail0a1b2c.ts.net`, `100.101.102.103` and `alice@github`. Update any test expectations that depend on the values you replace. Review the diff of every fixture file yourself, and never commit a capture as-is.

Also scrub `test/fixtures/api-services.*.json` if you regenerate them. They're the sample data for `web/dev-server.ts`.

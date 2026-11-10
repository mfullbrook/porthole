// Service identity keys and grouping (design: "Service identity", "Listener → service aggregation").

import { describe, expect, test } from "bun:test";
import { aggregate, launcherOf, type ProbeState } from "../src/aggregate.ts";
import { toListeners } from "../src/collect/parse.ts";
import { resolve } from "../src/resolve.ts";
import type { Binding, ProcessInfo } from "../src/types.ts";
import { HOME, OPTS, fixtureProbes, loadFixture, ok } from "./helpers.ts";

const keys = () => new Map(resolve(loadFixture(), fixtureProbes(), OPTS).drafts.map((d) => [d.identityPort, d.key]));

describe("fixture keys", () => {
  const k = keys();
  test("docker, launchd, git worktree, port", () => {
    expect(k.get(6006)).toBe("mac-mini/docker:open-webui-hermes");
    expect(k.get(3000)).toBe("mac-mini/git:~/code/acme/acme-website#~/code/acme/acme-website.worktrees/redesign:next-server");
    expect(k.get(8844)).toBe("mac-mini/git:~/projects/writer-app#~/projects/writer-app-v2:server@book/editor");
    expect(k.get(5173)).toBe("mac-mini/git:~/code/puzzle-game:vite");
  });
  test("Homebrew's own git checkout is ignored", () => {
    expect(k.get(6379)).not.toContain("git:");
    expect(k.get(7700)).toBe("mac-mini/launchd:homebrew.mxcl.meilisearch");
  });
  test("mailpit's SMTP and web ports are one service (same pid)", () => {
    const r = resolve(loadFixture(), fixtureProbes(), OPTS);
    const m = r.drafts.find((d) => d.name === "Mailpit")!;
    expect(m.ports.map((p) => [p.port, p.probe])).toEqual([[1025, "skipped"], [8025, "ok"]]);
    expect(m.hidden).toBeNull();
  });
  test("nginx workers sharing a port are one service", () => {
    const r = resolve(loadFixture(), fixtureProbes(), OPTS);
    expect(r.drafts.filter((d) => d.ports.some((p) => p.port === 80)).length).toBe(1);
  });
});

describe("launcher", () => {
  const p = (command: string): ProcessInfo => ({ pid: 1, ppid: 0, lstart: "", command, cwd: "/", git: null });
  test.each([
    ["node /Users/alice/code/x/node_modules/.bin/vite", "vite"],
    ["next-server (v16.3.5) ", "next-server"],
    ["/x/.venv/bin/python .venv/bin/uvicorn api.main:app --host 127.0.0.1", "uvicorn"],
    ["/x/venv/bin/python -m hermes_cli.main gateway run", "hermes_cli.main"],
    ["bun run /x/terminal-agent.ts", "terminal-agent"],
    ["php artisan serve", "artisan"],
    ["node node_modules/.bin/storybook dev -p 6006", "storybook"],
    ["nginx: worker process", "nginx"],
  ])("%s → %s", (cmd, want) => {
    expect(launcherOf(p(cmd))).toBe(want);
  });
  test("falls back to the parent npm run script", () => {
    expect(launcherOf(p("node -e 'x'"), p("npm run dev"))).toBe("dev");
  });
});

describe("stability", () => {
  const git = { toplevel: "/Users/alice/code/app", branch: "main", commonDir: "/Users/alice/code/app/.git" };
  const proc = (pid: number, command: string, cwd = "/Users/alice/code/app", ppid = 10): ProcessInfo => ({ pid, ppid, lstart: "t", command, cwd, git });
  const run = (bindings: Binding[], procs: ProcessInfo[], probes: [string, ProbeState][], parents: ProcessInfo[] = []) =>
    aggregate({
      host: "mac-mini", home: HOME, listeners: toListeners(bindings, []),
      processes: new Map(procs.map((x) => [x.pid, x])), parents: new Map(parents.map((x) => [x.pid, x])),
      docker: [], launchd: new Map(), probes: new Map(probes), deny: new Map(),
    });
  const b = (pid: number, port: number): Binding => ({ pid, command: "node", family: "IPv4", addr: "127.0.0.1", port });

  test("Vite moving 5173 → 5174 and restarting keeps its key", () => {
    const a = run([b(1, 5173)], [proc(1, "node node_modules/.bin/vite")], [["1:5173", ok("App")]]);
    const z = run([b(2, 5174)], [proc(2, "node node_modules/.bin/vite")], [["2:5174", ok("App")]]);
    expect(a[0]!.key).toBe(z[0]!.key);
  });
  test("Vite and Storybook in one worktree get distinct keys", () => {
    const s = run([b(1, 5173), b(2, 6006)], [proc(1, "node node_modules/.bin/vite"), proc(2, "node node_modules/.bin/storybook dev")], [["1:5173", ok("App")], ["2:6006", ok("Storybook")]]);
    expect(new Set(s.map((x) => x.key)).size).toBe(2);
  });
  test("two Vite apps in one monorepo get distinct keys (cwd below the root)", () => {
    const s = run(
      [b(1, 5173), b(2, 5174)],
      [proc(1, "node node_modules/.bin/vite", "/Users/alice/code/app/apps/web"), proc(2, "node node_modules/.bin/vite", "/Users/alice/code/app/apps/admin")],
      [["1:5173", ok("Web")], ["2:5174", ok("Admin")]],
    );
    expect(s.map((x) => x.key).sort()).toEqual([
      "mac-mini/git:~/code/app:vite@apps/admin",
      "mac-mini/git:~/code/app:vite@apps/web",
    ]);
  });
  test("npm run siblings: a port with no page joins the app; one with a page stays separate", () => {
    const npm = { ...proc(10, "npm run dev"), ppid: 1 };
    const s = run(
      [b(1, 3000), b(2, 3001), b(3, 6006)],
      [proc(1, "node next dev"), proc(2, "node ws-server.js"), proc(3, "node node_modules/.bin/storybook dev")],
      [["1:3000", ok("App")], ["2:3001", ok(null, { status: 426, html: false })], ["3:6006", ok("Storybook")]],
      [npm],
    );
    expect(s.map((x) => x.ports.map((p) => p.port))).toEqual([[3000, 3001], [6006]]);
    expect(s[0]!.name).toBe("App");
  });
  test("identity port ignores route state: lowest titled port, not the best route", () => {
    const s = run([b(1, 3000), b(1, 3001)], [proc(1, "node server.js")], [["1:3000", ok(null, { html: false })], ["1:3001", ok("Dashboard")]]);
    expect(s[0]!.identityPort).toBe(3001);
    expect(s[0]!.name).toBe("Dashboard");
  });
});

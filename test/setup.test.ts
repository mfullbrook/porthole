// setup / teardown against a simulated `tailscale serve` (design: "Setup").

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, type Config } from "../src/config.ts";
import { runSetup, runTeardown, type Sys } from "../src/setup.ts";

const ROOT = "/opt/porthole";
const H = "mac-mini.t.ts.net";
const tmp = mkdtempSync(join(tmpdir(), "porthole-setup-"));
process.env.PORTHOLE_CONFIG_DIR = tmp;
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.PORTHOLE_CONFIG_DIR;
});

type Handlers = Record<string, { Proxy: string }>;

class FakeSys implements Sys {
  web: Record<number, Handlers> = {};
  tcp: Record<number, { HTTPS?: boolean; HTTP?: boolean }> = {};
  listening = new Map<number, string>(); // port → command
  agent = false;
  logs: string[] = [];
  calls: string[] = [];

  constructor(initial: Record<number, Handlers>) {
    for (const [p, h] of Object.entries(initial)) this.set(Number(p), h);
    this.listening.set(7317, "node src/server.js");
    this.listening.set(8765, "node remote-console");
  }
  set(port: number, h: Handlers) {
    this.web[port] = h;
    this.tcp[port] = { HTTPS: true };
  }
  get root() {
    return this.web[443]?.["/"]?.Proxy;
  }
  async tailscale(args: string[]) {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${H}.`, Tags: null } }));
    if (args.join(" ") === "serve status --json") {
      const Web = Object.fromEntries(Object.entries(this.web).map(([p, h]) => [`${H}:${p}`, { Handlers: h }]));
      return ok(JSON.stringify({ TCP: this.tcp, Web }));
    }
    this.calls.push(args.join(" "));
    const port = Number(args.find((a) => a.startsWith("--https="))!.split("=")[1]);
    const path = args.find((a) => a.startsWith("--set-path="))?.split("=")[1];
    const last = args[args.length - 1]!;
    if (last === "off") {
      if (path) {
        delete this.web[port]?.[path];
        if (this.web[port] && !Object.keys(this.web[port]!).length) delete this.web[port], delete this.tcp[port];
      } else delete this.web[port], delete this.tcp[port];
    } else {
      this.set(port, { ...(this.web[port] ?? {}), [path ?? "/"]: { Proxy: last } });
    }
    return ok();
  }
  async listeners() {
    const out = [...this.listening].map(([port, command]) => ({ port, pid: port, command }));
    if (this.agent) {
      const cfg = loadConfig();
      for (const port of [cfg.portA, cfg.localPort]) out.push({ port, pid: 1, command: `/bun ${ROOT}/src/cli.ts run` });
    }
    return out;
  }
  async installAgent() {
    this.agent = true;
  }
  async removeAgent() {
    this.agent = false;
  }
  async waitForDaemon() {
    return this.agent;
  }
  async freePort() {
    return 50123;
  }
  log(m: string) {
    this.logs.push(m);
  }
}

const cfg = (): Config => ({ ...loadConfig(), bins: { lsof: "/bin/sh", ps: "/bin/sh", git: "/bin/sh", launchctl: "/bin/sh", tailscale: "/bin/sh", docker: "/nonexistent" } });
const setup = (sys: FakeSys, keepRoot = false, dryRun = false) => runSetup(sys, cfg(), { root: ROOT, bun: "/bun", keepRoot, dryRun });
const teardown = (sys: FakeSys) => runTeardown(sys, cfg(), { dryRun: false });
const existingServe = () => ({
  443: { "/": { Proxy: "http://127.0.0.1:7317" }, "/rc": { Proxy: "http://127.0.0.1:8765/rc" } },
  4330: { "/": { Proxy: "http://127.0.0.1:4332" } },
  6006: { "/": { Proxy: "http://127.0.0.1:6006" } },
});

beforeEach(() => {
  for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { force: true });
});

describe("setup", () => {
  test("adds :7443, repoints / and leaves every other handler alone", async () => {
    const sys = new FakeSys(existingServe());
    expect(await setup(sys)).toBe(0);
    expect(sys.web[7443]).toEqual({ "/": { Proxy: "http://127.0.0.1:50123" } });
    expect(sys.root).toBe("http://127.0.0.1:50123");
    expect(sys.web[443]!["/rc"]).toEqual({ Proxy: "http://127.0.0.1:8765/rc" });
    expect(sys.web[4330]).toEqual(existingServe()[4330]);
    expect(sys.web[6006]).toEqual(existingServe()[6006]);
    expect(loadConfig()).toMatchObject({ portA: 50123, fqdn: H, remotePort: 7443, localPort: 7444 });
    expect(existsSync(join(tmp, "serve-backup.json"))).toBe(true);
  });

  test("--dry-run changes nothing", async () => {
    const sys = new FakeSys(existingServe());
    expect(await setup(sys, false, true)).toBe(0);
    expect(sys.calls).toEqual([]);
    expect(sys.agent).toBe(false);
    expect(existsSync(join(tmp, "config.json"))).toBe(false);
  });

  test("--keep-root adds only the dedicated origin", async () => {
    const sys = new FakeSys(existingServe());
    expect(await setup(sys, true)).toBe(0);
    expect(sys.root).toBe("http://127.0.0.1:7317");
    expect(sys.web[7443]).toBeDefined();
  });

  test("refuses a :7443 already used by serve or a listener", async () => {
    const used = new FakeSys({ ...existingServe(), 7443: { "/": { Proxy: "http://127.0.0.1:9999" } } });
    expect(await setup(used)).toBe(1);
    expect(used.calls).toEqual([]);
    const listener = new FakeSys(existingServe());
    listener.listening.set(7444, "python -m http.server 7444");
    expect(await setup(listener)).toBe(1);
    expect(listener.logs.join("\n")).toContain(":7444");
  });

  test("twice, then teardown, restores the previous root (the backup isn't overwritten)", async () => {
    const sys = new FakeSys(existingServe());
    expect(await setup(sys)).toBe(0);
    expect(await setup(sys)).toBe(0);
    expect(loadConfig().portA).toBe(50123); // kept, not re-picked
    expect(await teardown(sys)).toBe(0);
    expect(sys.root).toBe("http://127.0.0.1:7317");
    expect(sys.web[7443]).toBeUndefined();
    expect(sys.web[443]!["/rc"]).toBeDefined();
    expect(sys.agent).toBe(false);
    expect(existsSync(join(tmp, "serve-backup.json"))).toBe(false);
    expect(readdirSync(tmp).some((f) => /^serve-backup\..+\.json$/.test(f))).toBe(true);
  });

  test("setup → teardown → point / elsewhere → setup → teardown restores the new target", async () => {
    const sys = new FakeSys(existingServe());
    await setup(sys);
    await teardown(sys);
    sys.listening.set(3000, "node next");
    await sys.tailscale(["serve", "--bg", "--https=443", "--set-path=/", "http://127.0.0.1:3000"]);
    await setup(sys);
    expect(sys.root).toBe("http://127.0.0.1:50123");
    await teardown(sys);
    expect(sys.root).toBe("http://127.0.0.1:3000");
  });

  test("teardown when the backed-up target no longer listens removes / and says so", async () => {
    const sys = new FakeSys(existingServe());
    await setup(sys);
    sys.listening.delete(7317);
    await teardown(sys);
    expect(sys.root).toBeUndefined();
    expect(sys.web[443]!["/rc"]).toBeDefined();
    expect(sys.logs.join("\n")).toContain("isn't listening any more");
  });

  test("teardown with no backup leaves / alone and says so", async () => {
    const sys = new FakeSys(existingServe());
    await setup(sys);
    rmSync(join(tmp, "serve-backup.json"));
    await teardown(sys);
    expect(sys.root).toBe("http://127.0.0.1:50123");
    expect(sys.logs.join("\n")).toContain("no serve backup");
  });

  test("teardown twice is harmless", async () => {
    const sys = new FakeSys(existingServe());
    await setup(sys);
    await teardown(sys);
    const snapshot = JSON.stringify(sys.web);
    expect(await teardown(sys)).toBe(0);
    expect(JSON.stringify(sys.web)).toBe(snapshot);
  });
});

test("defaults", () => {
  expect(DEFAULT_CONFIG).toMatchObject({ remotePort: 7443, localPort: 7444, portA: 0 });
});

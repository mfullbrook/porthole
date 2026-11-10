// Acceptance cases from the design doc, run against the 2026-10-08 fixtures.

import { describe, expect, test } from "bun:test";
import { resolve, verifyAll, fixesFor } from "../src/resolve.ts";
import { viewSnapshot, type ServiceView, type Viewer } from "../src/select.ts";
import type { Collected, Snapshot } from "../src/types.ts";
import { FQDN, OPTS, fixtureHttp, fixtureProbes, loadFixture, ok, res, scripted } from "./helpers.ts";
import type { HttpClient } from "../src/http.ts";
import type { ProbeState } from "../src/aggregate.ts";

async function run(c: Collected = loadFixture(), probes = fixtureProbes(), http: HttpClient = fixtureHttp()) {
  const r = resolve(c, probes, OPTS);
  await verifyAll(r, { http, skip: (d) => !!d.hidden, now: 1 });
  const snap: Snapshot = {
    scannedAt: 1, verifiedAt: 1, host: "mac-mini", fqdn: FQDN, tailscaleIPv4: "100.101.102.103", ownerLogin: "alice@github",
    services: r.drafts, warnings: [], error: null,
  };
  const ctx = { overrides: { version: 1 as const, services: {} }, remembered: {}, ipv4: "100.101.102.103", fixes: fixesFor(r) };
  const view = (v: Viewer) => viewSnapshot(snap, v, ctx);
  return { r, remote: view("remote"), local: view("local") };
}

const byName = (vs: ServiceView[], name: string) => {
  const s = vs.find((v) => v.name === name);
  if (!s) throw new Error(`no service named ${name}: ${vs.map((v) => v.name).join(", ")}`);
  return s;
};
const brief = (s: ServiceView) => ({ state: s.state, label: s.label, url: s.url, reason: s.reason, caveat: s.caveat });

describe("acceptance (remote viewer unless noted)", async () => {
  const { remote, local } = await run();

  test("OpenWebUI: ✓ serve :6006", () => {
    const s = byName(remote, "Open WebUI");
    expect(brief(s)).toMatchObject({ state: "verified", label: "serve :6006", url: `https://${FQDN}:6006/` });
    expect(s.key).toBe("mac-mini/docker:open-webui-hermes");
    expect(s.group).toBe("open-webui-hermes");
    expect(s.ports.map((p) => p.port)).toEqual([6006]); // OrbStack internals stay out
  });

  test("remote-console: /rc works, and localhost:8765/rc on the Mac mini", () => {
    expect(brief(byName(remote, "remote-console · 127.0.0.1:8765"))).toMatchObject({ state: "verified", label: "/rc", url: `https://${FQDN}/rc` });
    expect(brief(byName(local, "remote-console · 127.0.0.1:8765"))).toMatchObject({ state: "verified", url: "http://localhost:8765/rc" });
  });

  test("writer-app worktree: ✓ mac-mini:8844 on both listeners", () => {
    const r = byName(remote, "Book editor · Writer App");
    expect(brief(r)).toMatchObject({ state: "verified", label: "mac-mini:8844", url: "http://mac-mini:8844/" });
    expect(r.branch).toBe("v2");
    expect(r.worktree).toBe("writer-app-v2");
    expect(r.group).toBe("writer-app");
    expect(brief(byName(local, "Book editor · Writer App"))).toMatchObject({ state: "verified", url: "http://mac-mini:8844/" });
  });

  test("Puzzle Game: ✕ no route · ::1 only remotely, ✓ localhost:5173 on listener B", () => {
    const r = byName(remote, "Puzzle Game");
    expect(brief(r)).toMatchObject({ state: "no_route", url: null, reason: "::1 only, not served" });
    expect(r.fix?.commands[0]!.cmd).toBe("tailscale serve --bg --https=5173 http://[::1]:5173");
    expect(r.fix?.commands[1]!.cmd).toBe("tailscale serve --https=5173 off");
    expect(r.fix?.notes.join(" ")).toContain(`allowedHosts: ["${FQDN}"]`);
    expect(r.fix?.notes.join(" ")).toContain("--host 100.101.102.103");
    expect(r.fix?.commands.map((x) => x.cmd).join(" ")).not.toMatch(/--host|0\.0\.0\.0/);
    expect(brief(byName(local, "Puzzle Game"))).toMatchObject({ state: "verified", url: "http://localhost:5173/" });
  });

  test("acme-app :5174: blocked · not the app (both viewers)", () => {
    const r = byName(remote, "Laravel Vite");
    expect(brief(r)).toMatchObject({ state: "blocked", url: null, reason: "not the app: Vite asset server" });
    expect(r.fix?.title).toContain("not the app");
    expect(brief(byName(local, "Laravel Vite"))).toMatchObject({ state: "blocked", reason: "not the app: Vite asset server" });
  });

  test(":8443 TLS-only with a bad certificate: inferred, still openable", () => {
    const r = byName(remote, "Live Captions");
    expect(brief(r)).toMatchObject({ state: "inferred", url: "https://mac-mini:8443/", caveat: "certificate expired" });
  });

  test("redirect within the host is followed (notes-app /login)", () => {
    expect(brief(byName(remote, "Sign in · Notes"))).toMatchObject({ state: "verified", url: "http://mac-mini:3100/" });
  });

  test("dual-stack IPv6 wildcard prefers the short name", () => {
    expect(brief(byName(remote, "Home · Acme"))).toMatchObject({ state: "verified", url: "http://mac-mini:3000/" });
  });

  test("book editor on serve HTTP :4330 → http short name, never the FQDN", () => {
    const s = byName(remote, "Writer App — Book editor");
    expect(brief(s)).toMatchObject({ state: "verified", url: "http://mac-mini:4330/", label: "serve :4330" });
    expect(brief(byName(local, "Writer App — Book editor"))).toMatchObject({ url: "http://localhost:4332/" });
  });

  test("the app behind serve :443 / is shown at the bare FQDN", () => {
    expect(brief(byName(remote, "Dashboard"))).toMatchObject({ state: "verified", url: `https://${FQDN}/` });
  });

  test("Hermes and Mailpit are visible and verified", () => {
    expect(byName(remote, "Hermes")).toMatchObject({ state: "verified", hidden: null, url: "http://mac-mini:8787/" });
    expect(byName(remote, "Mailpit")).toMatchObject({ state: "verified", hidden: null });
  });

  test("noise is hidden with reasons, and only ~a dozen services show", () => {
    const shown = remote.filter((s) => !s.hidden).map((s) => s.name).sort();
    expect(shown).toEqual([
      "Book editor · Writer App",
      "Dashboard",
      "Hermes",
      "Home · Acme",
      "Laravel Vite",
      "Live Captions",
      "Mailpit",
      "Open WebUI",
      "Puzzle Game",
      "Sign in · Notes",
      "Writer App — Book editor",
      "remote-console · 127.0.0.1:8765",
    ]);
    const reason = (port: number) => remote.find((s) => s.ports.some((p) => p.port === port))?.hidden;
    expect(reason(80)).toBe("Herd: local .test sites only");
    expect(reason(5432)).toBe("not a web service");
    expect(reason(7700)).toBe("not a web service");
    expect(reason(49152)).toBe("macOS system service");
    expect(reason(55201)).toBe("CLI helper (codex)");
    expect(reason(57522)).toBe("worker process (multiprocessing)");
    expect(reason(32222)).toBe("OrbStack internal port");
    expect(reason(7317)).toBeNull(); // no built-in rule for it: hide it with an override
    expect(reason(8642)).toBe("no page (API)");
    expect(reason(8384)).toBe("Syncthing");
  });
});

describe("deny rules run before any probe", () => {
  test("no request is ever sent to a denied listener", async () => {
    const http = fixtureHttp();
    await run(loadFixture(), fixtureProbes(), http);
    for (const port of [80, 5432, 6379, 7700, 1025, 22000, 49152, 5000, 7000, 57522, 64766, 32222, 8384]) {
      expect(http.calls.filter((u) => new RegExp(`:${port}/`).test(u))).toEqual([]);
    }
  });

  test("docker down: OrbStack ports are shown by port, not hidden as internal", async () => {
    const c = loadFixture();
    c.docker = null;
    const { remote } = await run(c);
    const orb = remote.filter((s) => s.ports.some((p) => p.process.startsWith("OrbStack")));
    expect(orb.some((s) => s.hidden === "OrbStack internal port")).toBe(false);
  });
});

describe("serve edge cases", () => {
  test("v4 serve upstream with a ::1-only listener → blocked, not not-responding", async () => {
    const c = loadFixture();
    c.serve!.push({ servePort: 5173, https: true, path: "/", upstream: { scheme: "http", host: "127.0.0.1", port: 5173, path: "" }, raw: "http://127.0.0.1:5173" });
    // serve itself would answer 502 here; the pre-fetch family check must win.
    const http = fixtureHttp();
    const { remote } = await run(c, fixtureProbes(), http);
    const s = byName(remote, "Puzzle Game");
    expect(brief(s)).toMatchObject({ state: "blocked", reason: "serve points at 127.0.0.1:5173, app is on [::1]" });
    expect(s.fix?.commands[0]!.cmd).toBe("tailscale serve --bg --https=5173 http://[::1]:5173");
  });

  test("serve mapping with nothing listening → not responding row", async () => {
    const c = loadFixture();
    c.serve!.push({ servePort: 4400, https: true, path: "/", upstream: { scheme: "http", host: "127.0.0.1", port: 4999, path: "" }, raw: "" });
    const http = scripted({ ...Object.fromEntries([]), [`https://${FQDN}:4400/`]: res(502, "") });
    const { remote } = await run(c, fixtureProbes(), http);
    const s = remote.find((v) => v.key === "mac-mini/serve:4400")!;
    expect(brief(s)).toMatchObject({ state: "not_responding", reason: "serve can't reach 127.0.0.1:4999" });
    expect(s.fix?.commands[0]!.cmd).toBe("tailscale serve --https=4400 off");
  });

  test("porthole's own mappings are not services", async () => {
    const c = loadFixture();
    const r = resolve(c, fixtureProbes(), { ...OPTS, selfPorts: new Set([7317]) });
    expect(r.drafts.some((d) => d.key.includes("serve:"))).toBe(false);
  });
});

describe("IPv6 wildcard binds", () => {
  test("v6-only wildcard: short name refused, Tailscale IPv6 verifies", async () => {
    const c = loadFixture();
    c.bindings.push({ pid: 4242, command: "python3", family: "IPv6", addr: "*", port: 9100 });
    c.processes.set(4242, { pid: 4242, ppid: 1, lstart: "x", command: "python3 app.py", cwd: "/Users/alice/code/thing", git: null });
    const probes = fixtureProbes();
    probes.set("4242:9100", ok("Thing"));
    const http = fixtureHttp();
    const base = http as unknown as (u: string, o?: { host?: string }) => ReturnType<HttpClient>;
    const wrapped: HttpClient = (u, o) => (u === "http://[fd7a:115c:a1e0::1234:5678]:9100/" ? Promise.resolve(res(200, "<title>Thing</title>")) : base(u, o));
    const { remote } = await run(c, probes, wrapped);
    expect(brief(byName(remote, "Thing"))).toMatchObject({ state: "verified", url: "http://[fd7a:115c:a1e0::1234:5678]:9100/" });
  });
});

describe("identifying and backoff states", () => {
  test("a listener not yet probed shows identifying…", async () => {
    const probes = fixtureProbes();
    probes.delete("71125:8787");
    const { remote } = await run(loadFixture(), probes);
    const s = remote.find((v) => v.ports.some((p) => p.port === 8787))!;
    expect(s.state).toBe("identifying");
  });

  test("no HTTP response after backoff → hidden, still listed", async () => {
    const probes = fixtureProbes();
    probes.set("71125:8787", { state: "no_http", result: null } as ProbeState);
    const { remote } = await run(loadFixture(), probes);
    expect(remote.find((v) => v.ports.some((p) => p.port === 8787))!.hidden).toBe("no HTTP response");
  });
});

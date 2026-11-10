// Fixture loading and a scripted HTTP client for resolver tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeState } from "../src/aggregate.ts";
import { parseDockerPs, parseLaunchctlList, parseLsof, parseServeStatus, parseTailscaleStatus } from "../src/collect/parse.ts";
import type { FetchOutcome, HttpClient } from "../src/http.ts";
import type { Collected, ProbeResult, ProcessInfo } from "../src/types.ts";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const INTERACTIVE = join(FIXTURES, "2026-10-08-interactive");
export const LAUNCHAGENT = join(FIXTURES, "2026-10-08-launchagent");
export const HOME = "/Users/alice";
export const FQDN = "mac-mini.tail0a1b2c.ts.net";

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");

export function loadFixture(dir = INTERACTIVE): Collected {
  const processes = new Map<number, ProcessInfo>();
  for (const line of read(dir, "processes.jsonl").split("\n")) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as ProcessInfo;
    processes.set(p.pid, p);
  }
  return {
    bindings: parseLsof(read(dir, "lsof-listen.txt")),
    processes,
    parents: new Map(),
    serve: parseServeStatus(read(dir, "serve-status.json")),
    tailscale: parseTailscaleStatus(read(dir, "tailscale-self.json")),
    docker: parseDockerPs(read(dir, "docker-ps.jsonl")),
    launchd: parseLaunchctlList(read(dir, "launchctl-list.txt")),
    warnings: [],
  };
}

export function ok(title: string | null, extra: Partial<ProbeResult> = {}): ProbeState {
  return {
    state: "ok",
    result: { ok: true, scheme: "http", status: 200, title, html: !!title, favicon: null, blockedSignature: null, error: null, ...extra },
  };
}

/**
 * Identity-probe results for the interactive fixture, as captured from the live
 * machine on 2026-10-08 (titles via loopback). Keyed `${pid}:${port}`.
 */
export function fixtureProbes(): Map<string, ProbeState> {
  return new Map<string, ProbeState>([
    ["33666:3000", ok("Home · Acme")],
    ["64204:3100", ok("Sign in · Notes")],
    ["83884:4332", ok("Writer App — Book editor")],
    ["18246:5173", ok("Puzzle Game")],
    ["15088:5174", ok("Laravel Vite", { status: 404, blockedSignature: "laravel-vite-placeholder" })],
    ["39662:6006", ok("Open WebUI")],
    ["33617:7317", ok("Dashboard")],
    ["6103:8025", ok("Mailpit")],
    ["68766:8000", ok(null, { status: 404, html: false })],
    ["44607:8443", ok("Live Captions", { scheme: "https" })],
    ["55528:8642", ok(null, { status: 404, html: false })],
    ["35626:8765", ok("remote-console · 127.0.0.1:8765")],
    ["71125:8787", ok("Hermes")],
    ["59790:8844", ok("Book editor · Writer App")],
    ["31789:63250", ok(null, { status: 404, html: false })],
    ["97419:64791", ok(null, { status: 404, html: false })],
  ]);
}

export function res(status: number, body = "", extra: Partial<Extract<FetchOutcome, { kind: "response" }>> = {}): FetchOutcome {
  return { kind: "response", status, contentType: "text/html", location: null, body, certError: null, ...extra };
}

/**
 * Scripted client: exact URL → outcome, or URL|host → outcome for Host-overridden
 * fetches. Unknown URLs are refused. Records every request.
 */
export function scripted(routes: Record<string, FetchOutcome>): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, opts?: { host?: string }) => {
    const k = opts?.host ? `${url}|${opts.host}` : url;
    calls.push(k);
    return routes[k] ?? routes[url] ?? { kind: "refused" };
  }) as HttpClient & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** The hairpin results captured in hairpin.tsv, plus the loopback fetches local candidates make. */
export function fixtureHttp(): ReturnType<typeof scripted> {
  return scripted({
    "http://mac-mini:3000/": res(200, "<title>Acme</title>"),
    "http://[fd7a:115c:a1e0::1234:5678]:3000/": res(200, "<title>Acme</title>"),
    "http://mac-mini:3100/": res(307, "", { location: "/login?next=%2F" }),
    "http://mac-mini:3100/login?next=%2F": res(200, "<title>Sign in · Notes</title>"),
    "http://mac-mini:4330/": res(200, "<title>Book editor</title>"),
    "http://mac-mini:5174/": res(403, 'Blocked request. This host ("mac-mini") is not allowed.\nTo allow this host, add "mac-mini" to `server.allowedHosts` in vite.config.js.', { contentType: "text/plain" }),
    "http://mac-mini:8025/": res(200, "<title>Mailpit</title>"),
    "http://[fd7a:115c:a1e0::1234:5678]:8025/": res(200, "<title>Mailpit</title>"),
    "http://mac-mini:8443/": { kind: "reset", message: "ECONNRESET" },
    "https://mac-mini:8443/": res(200, "<title>Live Captions</title>", { certError: "certificate expired" }),
    "https://[fd7a:115c:a1e0::1234:5678]:8443/": res(200, "<title>Live Captions</title>", { certError: "certificate expired" }),
    "http://mac-mini:8787/": res(200, "<title>Hermes</title>"),
    "http://mac-mini:8844/": res(200, "<title>Book editor · Writer App</title>"),
    [`https://${FQDN}/`]: res(200, "<title>Dashboard</title>"),
    [`https://${FQDN}/rc`]: res(200, "<title>remote-console</title>"),
    [`https://${FQDN}:6006/`]: res(200, "<title>Open WebUI</title>"),
    // local candidates: fetched by address with Host: localhost:P
    "http://[::1]:5173/|localhost:5173": res(200, "<title>Puzzle Game</title>"),
    "http://127.0.0.1:5174/|localhost:5174": res(404, "<title>Laravel Vite</title> This is the Vite development server that provides Hot Module Replacement for your Laravel application."),
    "http://127.0.0.1:8765/rc|localhost:8765": res(200, "<title>remote-console</title>"),
    "http://127.0.0.1:4332/|localhost:4332": res(200, "<title>Book editor</title>"),
    "http://127.0.0.1:6006/|localhost:6006": res(200, "<title>Open WebUI</title>"),
    "http://127.0.0.1:8787/|localhost:8787": res(200, "<title>Hermes</title>"),
    "http://127.0.0.1:8025/|localhost:8025": res(200, "<title>Mailpit</title>"),
    "http://127.0.0.1:3000/|localhost:3000": res(200, "<title>Acme</title>"),
    "http://127.0.0.1:3100/|localhost:3100": res(307, "", { location: "/login?next=%2F" }),
    "http://127.0.0.1:3100/login?next=%2F|localhost:3100": res(200, "<title>Sign in · Notes</title>"),
    "https://127.0.0.1:8443/|localhost:8443": res(200, "<title>Captions</title>", { certError: "self-signed certificate" }),
  });
}

export const OPTS = { host: "mac-mini", home: HOME, selfPid: 999_999, selfPorts: new Set<number>() };

/**
 * fixtureHttp plus loopback identity-probe answers built from fixtureProbes(),
 * for tests that run the real Scanner (which probes before resolving).
 */
export function scannerHttp(): HttpClient {
  const base = fixtureHttp();
  const byPort = new Map<number, ProbeState>();
  for (const [k, v] of fixtureProbes()) byPort.set(Number(k.split(":")[1]), v);
  return async (url, opts) => {
    const m = url.match(/^(https?):\/\/(127\.0\.0\.1|\[::1\]|100\.101\.102\.103):(\d+)(\/.*)$/);
    if (m && !opts?.host) {
      const p = byPort.get(Number(m[3]));
      const r = p?.result;
      if (!r) return { kind: "refused" };
      if (r.scheme === "https" && m[1] === "http") return { kind: "reset", message: "ECONNRESET" };
      const body = r.title ? `<!doctype html><title>${r.title}</title>` : '{"detail":"Not Found"}';
      return res(r.status ?? 200, body, { contentType: r.html ? "text/html" : "application/json" });
    }
    return base(url, opts);
  };
}

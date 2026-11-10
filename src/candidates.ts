// Route candidates per service, for both viewers (design: "Route candidates
// and ranking"). Pure: bind × serve config × probe scheme → candidate URLs.

import type { ServiceDraft, ProbeState } from "./aggregate.ts";
import type { Candidate, Listener, ServeMapping, ServeUpstream, TailscaleSelf } from "./types.ts";

export interface CandidateContext {
  ts: TailscaleSelf | null;
  serve: ServeMapping[];
  listeners: Listener[];
  probes: Map<string, ProbeState>;
  /** porthole's own loopback ports: mappings to them are porthole's, not services. */
  selfPorts: Set<number>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export type UpstreamMatch = "match" | "mismatch" | "none";

/** Does a serve upstream reach this listener? "mismatch" = right port, wrong address family. */
export function upstreamMatches(up: ServeUpstream, l: Listener): UpstreamMatch {
  if (up.port !== l.port) return "none";
  const k = new Set(l.binds.map((b) => b.kind));
  const v4 = k.has("loopback4") || k.has("wildcard4") || k.has("wildcard6");
  const v6 = k.has("loopback6") || k.has("wildcard6");
  const h = up.host;
  if (h === "localhost") return v4 || v6 ? "match" : "mismatch";
  if (h.startsWith("127.")) return v4 ? "match" : v6 ? "mismatch" : "none";
  if (h === "::1") return v6 ? "match" : v4 ? "mismatch" : "none";
  if (l.binds.some((b) => b.addr === h) || k.has("wildcard4") || k.has("wildcard6")) return "match";
  return "none";
}

export function serveUrl(m: ServeMapping, ts: TailscaleSelf): string {
  const path = m.path === "/" ? "/" : m.path;
  if (m.https) return `https://${ts.fqdn}${m.servePort === 443 ? "" : `:${m.servePort}`}${path}`;
  // Plain-http candidates never use the FQDN (HSTS is per host across ports).
  return `http://${ts.hostName}:${m.servePort}${path}`;
}

export function serveLabel(m: ServeMapping): string {
  if (m.servePort === 443) return m.path === "/" ? "serve /" : m.path;
  return `serve :${m.servePort}${m.path === "/" ? "" : m.path}`;
}

function upstreamText(up: ServeUpstream): string {
  const h = up.host.includes(":") ? `[${up.host}]` : up.host;
  return `${h}:${up.port}`;
}

/** Mappings porthole treats as services (not porthole's own, proxy handlers only). */
export function serviceMappings(ctx: CandidateContext): ServeMapping[] {
  return ctx.serve.filter((m) => m.upstream && !(LOOPBACK_HOSTS.has(m.upstream.host) && ctx.selfPorts.has(m.upstream.port)));
}

export function listenerOnPort(port: number, listeners: Listener[]): boolean {
  return listeners.some((l) => l.port === port);
}

/** Serve mappings whose loopback upstream has no listener in either family. */
export function deadMappings(ctx: CandidateContext): ServeMapping[] {
  return serviceMappings(ctx).filter(
    (m) => LOOPBACK_HOSTS.has(m.upstream!.host) && !listenerOnPort(m.upstream!.port, ctx.listeners),
  );
}

function directRemote(l: Listener, scheme: string, ts: TailscaleSelf, viewer: "remote" | "local"): Candidate[] {
  const k = new Set(l.binds.map((b) => b.kind));
  const out: Candidate[] = [];
  const short = (): Candidate => ({
    url: `${scheme}://${ts.hostName}:${l.port}/`,
    label: `${ts.hostName}:${l.port}`,
    kind: "direct",
    port: l.port,
    viewer,
  });
  const ts6 = l.binds.find((b) => b.kind === "tailscale6")?.addr ?? ts.ips.find((ip) => ip.includes(":"));
  const v6 = (): Candidate => ({
    url: `${scheme}://[${ts6}]:${l.port}/`,
    label: `[${ts6}]:${l.port}`,
    kind: "direct",
    port: l.port,
    viewer,
  });
  if (k.has("wildcard4") || k.has("tailscale4")) out.push(short());
  else if (k.has("wildcard6")) {
    // lsof can't tell dual-stack from v6-only: emit both, verification chooses.
    out.push(short());
    if (ts6) out.push(v6());
  }
  if (k.has("tailscale6") && ts6 && !out.some((c) => c.url.includes("["))) out.push(v6());
  return out;
}

export function candidatesFor(svc: ServiceDraft, ctx: CandidateContext): Candidate[] {
  const { ts } = ctx;
  if (svc.deadServe) {
    if (!ts) return [];
    const m = svc.deadServe;
    const c = { url: serveUrl(m, ts), label: serveLabel(m), kind: m.https ? "serve_https" : "serve_http", port: m.upstream!.port, upstreamPort: m.upstream!.port } as const;
    return [{ ...c, viewer: "remote" }, { ...c, viewer: "local" }];
  }
  const remote: Candidate[] = [];
  const local: Candidate[] = [];
  const mappings = serviceMappings(ctx);
  for (const l of svc.listeners) {
    const port = svc.ports.find((p) => p.port === l.port && p.pid === l.pid);
    if (port?.probe === "skipped") continue;
    const scheme = ctx.probes.get(`${l.pid}:${l.port}`)?.result?.scheme ?? null;

    // serve mappings attached to this listener
    const attached: ServeMapping[] = [];
    for (const m of mappings) {
      const match = upstreamMatches(m.upstream!, l);
      if (match === "none" || !ts) continue;
      if ([...remote, ...local].some((c) => c.url === serveUrl(m, ts))) continue;
      const kind = m.https ? "serve_https" : "serve_http";
      const base = { url: serveUrl(m, ts), label: serveLabel(m), kind, port: l.port, upstreamPort: m.upstream!.port } as const;
      if (match === "mismatch") {
        const bound = l.binds.map((b) => (b.addr.includes(":") ? `[${b.addr}]` : b.addr)).join(", ");
        const preBlocked = { reason: `serve points at ${upstreamText(m.upstream!)}, app is on ${bound}` };
        remote.push({ ...base, viewer: "remote", preBlocked });
        local.push({ ...base, viewer: "local", preBlocked });
        continue;
      }
      attached.push(m);
      remote.push({ ...base, viewer: "remote" });
      local.push({ ...base, viewer: "local" });
    }

    if (!scheme) continue; // no direct candidate until a scheme is known
    if (ts) remote.push(...directRemote(l, scheme, ts, "remote"));

    const k = new Set(l.binds.map((b) => b.kind));
    const hasLocal = k.has("loopback4") || k.has("loopback6") || k.has("wildcard4") || k.has("wildcard6");
    if (hasLocal) {
      const paths = [...new Set(attached.map((m) => m.upstream!.path).filter(Boolean))];
      for (const path of paths.length ? paths : [""]) {
        local.push({ url: `${scheme}://localhost:${l.port}${path || "/"}`, label: `localhost:${l.port}${path}`, kind: "localhost", port: l.port, viewer: "local" });
      }
    } else if (ts) {
      local.push(...directRemote(l, scheme, ts, "local"));
    }
  }
  const dedupe = (cs: Candidate[]) => cs.filter((c, i) => cs.findIndex((x) => x.url === c.url) === i);
  return [...dedupe(remote), ...dedupe(local)];
}

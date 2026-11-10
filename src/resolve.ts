// The resolver: collected facts + probe results → services with candidates,
// then verification → routes. Shared by the scanner and the fixture tests.

import { aggregate, type ProbeState, type ServiceDraft } from "./aggregate.ts";
import { candidatesFor, deadMappings, listenerOnPort, serveLabel, type CandidateContext } from "./candidates.ts";
import { toListeners } from "./collect/parse.ts";
import { denyReason } from "./deny.ts";
import { fixFor } from "./fixes.ts";
import type { HttpClient } from "./http.ts";
import type { Candidate, Collected, Fix, Listener, Route } from "./types.ts";
import { classify, verify, type VerifyContext } from "./verify.ts";
import { bestRoute } from "./select.ts";
import { SIGNATURES } from "./signatures.ts";

export interface ResolveOptions {
  host: string;
  home: string;
  selfPid: number;
  /** porthole's own loopback ports (listener A/B). */
  selfPorts: Set<number>;
}

export function listenersOf(c: Collected): Listener[] {
  return toListeners(c.bindings, c.tailscale?.ips ?? []);
}

export function denyMap(c: Collected, listeners: Listener[], selfPid: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of listeners) {
    const reason = denyReason({ listener: l, proc: c.processes.get(l.pid), docker: c.docker, selfPid });
    if (reason) out.set(`${l.pid}:${l.port}`, reason);
  }
  return out;
}

/** Several drafts can share an identity key (same worktree + launcher on two ports). */
export const draftId = (d: ServiceDraft) => `${d.key}\0${d.pid ?? ""}:${d.identityPort ?? ""}`;

export interface Resolved {
  drafts: ServiceDraft[];
  candidates: Map<string, Candidate[]>;
  ctx: CandidateContext;
  listeners: Listener[];
}

export function resolve(c: Collected, probes: Map<string, ProbeState>, opts: ResolveOptions): Resolved {
  const listeners = listenersOf(c);
  const deny = denyMap(c, listeners, opts.selfPid);
  const host = c.tailscale?.hostName || opts.host;
  const drafts = aggregate({
    host,
    home: opts.home,
    listeners,
    processes: c.processes,
    parents: c.parents,
    docker: c.docker,
    launchd: c.launchd,
    probes,
    deny,
  });
  const ctx: CandidateContext = { ts: c.tailscale, serve: c.serve ?? [], listeners, probes, selfPorts: opts.selfPorts };
  for (const m of deadMappings(ctx)) {
    drafts.push({
      key: `${host}/serve:${m.servePort}${m.path === "/" ? "" : m.path}`,
      kind: "serve",
      name: serveLabel(m),
      group: "Other",
      project: null, branch: null, worktree: null, container: null, launchdLabel: null, launcher: null,
      cwd: null, pid: null, command: null, identityPort: m.upstream!.port,
      ports: [], hidden: null, identifying: false, routes: [], framework: null, packageManager: null,
      deadServe: m,
      listeners: [],
    });
  }
  const candidates = new Map<string, Candidate[]>();
  for (const d of drafts) {
    const cs = candidatesFor(d, ctx);
    candidates.set(draftId(d), cs);
    // A path-mounted serve route means a page exists even if / is a JSON 404.
    if (d.hidden === "no page (API)" && cs.some((x) => x.kind === "serve_https" || x.kind === "serve_http")) d.hidden = null;
  }
  return { drafts, candidates, ctx, listeners };
}

export interface VerifyAllOptions {
  http: HttpClient;
  concurrency?: number;
  /** Skip verification for these (hidden services): routes stay inferred-unknown. */
  skip?: (d: ServiceDraft) => boolean;
  now?: number;
  timeoutMs?: number;
  /** Previously verified results by candidateKey(); reused instead of fetching. */
  reuse?: Map<string, Route>;
}

export const candidateKey = (c: Candidate) => `${c.url}|${c.preBlocked?.reason ?? ""}`;

/**
 * Verify every candidate (deduped by URL), attach routes to drafts. Skipped
 * drafts get unverified routes. Returns every result by candidateKey().
 */
export async function verifyAll(r: Resolved, opts: VerifyAllOptions): Promise<Map<string, Route>> {
  const ts = r.ctx.ts;
  const hostSet = new Set<string>([ts?.hostName, ts?.fqdn, ...(ts?.ips ?? [])].filter(Boolean).map((h) => h!.toLowerCase()));
  const vctx: VerifyContext = {
    http: opts.http,
    hostSet,
    upstreamAlive: (port) => listenerOnPort(port, r.listeners),
    timeoutMs: opts.timeoutMs,
  };
  const now = opts.now ?? Date.now();
  const cache = new Map<string, Promise<Route>>();
  for (const [k, route] of opts.reuse ?? []) cache.set(k, Promise.resolve(route));
  const jobs: { d: ServiceDraft; c: Candidate }[] = [];
  const skipped = new Set<ServiceDraft>();
  for (const d of r.drafts) {
    if (opts.skip?.(d)) {
      skipped.add(d);
      continue;
    }
    for (const c of r.candidates.get(draftId(d)) ?? []) jobs.push({ d, c });
  }
  // Bounded concurrency (8 by default).
  const limit = opts.concurrency ?? 8;
  const results: Route[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const { c } = jobs[i]!;
      const k = candidateKey(c);
      let p = cache.get(k);
      if (!p) {
        p = verify(c, vctx, now);
        cache.set(k, p);
      }
      const route = await p;
      results[i] = { ...route, ...c, state: route.state, caveat: route.caveat, excluded: route.excluded, checkedAt: route.checkedAt };
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  for (const d of r.drafts) d.routes = skipped.has(d) ? unverifiedRoutes(r.candidates.get(draftId(d)) ?? []) : [];
  jobs.forEach(({ d }, i) => d.routes.push(results[i]!));
  for (const d of r.drafts) d.routes = d.routes.map((route) => notTheApp(d, route, r.ctx));
  const out = new Map<string, Route>();
  for (const [k, p] of cache) out.set(k, await p);
  return out;
}

/**
 * The loopback identity probe is authoritative about what a port is: when it
 * matched a "not the app" signature (Laravel's Vite placeholder), every route to
 * that port is "not the app", whatever the tailnet fetch said (e.g. Vite's 403).
 */
function notTheApp(d: ServiceDraft, route: Route, ctx: CandidateContext): Route {
  const l = d.listeners.find((x) => x.port === route.port);
  const sigId = l ? ctx.probes.get(`${l.pid}:${l.port}`)?.result?.blockedSignature : null;
  const sig = sigId ? SIGNATURES.find((s) => s.id === sigId) : null;
  if (!sig || sig.kind !== "not_app" || route.preBlocked) return route;
  return { ...route, state: "blocked", caveat: sig.caveat, excluded: true };
}

/** Unverified routes (hidden services, or before the first verification). */
export function unverifiedRoutes(cands: Candidate[]): Route[] {
  return cands.map((c) => ({
    ...c,
    ...(c.preBlocked ? classify(c, { outcome: { kind: "refused" }, redirect: null }, true) : { state: "inferred" as const, caveat: "not checked yet", excluded: false }),
    checkedAt: null,
  }));
}

export function fixesFor(r: Resolved): Map<string, { remote: Fix | null; local: Fix | null }> {
  const used = new Set((r.ctx.serve ?? []).map((m) => m.servePort));
  const out = new Map<string, { remote: Fix | null; local: Fix | null }>();
  for (const d of r.drafts) {
    out.set(d.key, {
      remote: fixFor(d, bestRoute(d.routes, "remote"), r.ctx.ts, used),
      local: fixFor(d, bestRoute(d.routes, "local"), r.ctx.ts, used),
    });
  }
  return out;
}

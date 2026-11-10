// Per-request route selection: a pure function of (snapshot, viewer, overrides).
// Produces the JSON the launcher page renders (see docs/api.md).

import type { Fix, Route, RouteState, Service, ServicePort, Snapshot } from "./types.ts";

export type Viewer = "remote" | "local";

export interface ServiceOverride {
  pin?: boolean;
  rename?: string;
  /** true hides; false shows a service porthole hid by rule. */
  hide?: boolean;
}

export interface Overrides {
  version: 1;
  services: Record<string, ServiceOverride>;
}

export interface Remembered {
  name: string;
  group: string;
  lastSeen: number;
  url: string | null;
}

export type ViewState = RouteState | "identifying" | "not_running";

export interface RouteView {
  url: string;
  label: string;
  state: RouteState;
  caveat: string | null;
  kind: Route["kind"];
}

export interface ServiceView {
  key: string;
  name: string;
  derivedName: string;
  group: string;
  project: string | null;
  branch: string | null;
  worktree: string | null;
  kind: Service["kind"];
  container: string | null;
  launchdLabel: string | null;
  pinned: boolean;
  /** Effective hidden reason (rule or user), null when shown. */
  hidden: string | null;
  state: ViewState;
  /** Set only when openable (verified / inferred). */
  url: string | null;
  label: string | null;
  caveat: string | null;
  /** Why it can't be opened (blocked / not responding / no route / not running). */
  reason: string | null;
  checkedAt: number | null;
  lastSeen: number | null;
  fix: Fix | null;
  routes: RouteView[];
  /** Remote viewer: the URL that works on the Mac mini itself. */
  localUrl: string | null;
  /** Tailscale IPv4 URL for devices without MagicDNS. */
  fallbackUrl: string | null;
  ports: ServicePort[];
  pid: number | null;
  command: string | null;
  cwd: string | null;
}

const STATE_ORDER: Record<RouteState, number> = { verified: 0, inferred: 1, blocked: 2, not_responding: 3, no_route: 4 };
const KIND_ORDER: Record<Viewer, Record<Route["kind"], number>> = {
  remote: { serve_https: 0, direct: 1, serve_http: 2, localhost: 3 },
  local: { localhost: 0, serve_https: 1, direct: 2, serve_http: 3 },
};

export function rank(r: Route, viewer: Viewer): number {
  return STATE_ORDER[r.state] * 10 + KIND_ORDER[viewer][r.kind];
}

/** Best route for the viewer; excluded ports only when every port is excluded. */
export function bestRoute(routes: Route[], viewer: Viewer): Route | null {
  const mine = routes.filter((r) => r.viewer === viewer);
  const usable = mine.filter((r) => !r.excluded);
  const pool = usable.length ? usable : mine;
  let best: Route | null = null;
  for (const r of pool) {
    if (!best || rank(r, viewer) < rank(best, viewer) || (rank(r, viewer) === rank(best, viewer) && r.port < best.port)) best = r;
  }
  return best;
}

export function noRouteReason(svc: Service): string {
  if (svc.identifying) return "identifying…";
  const live = svc.ports.filter((p) => p.probe !== "skipped");
  if (live.length && live.every((p) => p.probe === "no_http")) return "no HTTP response";
  const id = svc.ports.find((p) => p.port === svc.identityPort) ?? svc.ports[0];
  const binds = id?.binds ?? [];
  const has = (re: RegExp) => binds.some((b) => re.test(b));
  const v4 = has(/^127\./), v6 = has(/^\[::1\]/);
  if (v6 && !v4) return "::1 only, not served";
  if (v4 && !v6) return "127.0.0.1 only, not served";
  if (v4 && v6) return "localhost only, not served";
  if (binds.length) return `bound to ${binds[0]!.replace(/:\d+$/, "")} only`;
  return "no route";
}

export interface SelectContext {
  overrides: Overrides;
  remembered: Record<string, Remembered>;
  ipv4: string | null;
  /** Fix for (service, chosen route); computed in the scanner where facts live. */
  fixes: Map<string, { remote: Fix | null; local: Fix | null }>;
}

const OPENABLE = new Set<ViewState>(["verified", "inferred"]);

export function viewService(svc: Service, viewer: Viewer, ctx: SelectContext): ServiceView {
  const ov = ctx.overrides.services[svc.key] ?? {};
  const best = bestRoute(svc.routes, viewer);
  let state: ViewState;
  let reason: string | null = null;
  if (best) {
    state = best.state;
    if (!OPENABLE.has(state)) reason = best.caveat;
  } else if (svc.identifying) {
    state = "identifying";
  } else {
    state = "no_route";
    reason = noRouteReason(svc);
  }
  const hidden = ov.hide === true ? "hidden by you" : ov.hide === false ? null : svc.hidden;
  const local = bestRoute(svc.routes, "local");
  const direct = svc.ports.find((p) => p.scheme && p.binds.some((b) => /^\*:|^100\./.test(b)));
  const fix = ctx.fixes.get(svc.key)?.[viewer] ?? null;
  return {
    key: svc.key,
    name: ov.rename?.trim() || svc.name,
    derivedName: svc.name,
    group: svc.group,
    project: svc.project,
    branch: svc.branch,
    worktree: svc.worktree,
    kind: svc.kind,
    container: svc.container,
    launchdLabel: svc.launchdLabel,
    pinned: !!ov.pin,
    hidden,
    state,
    url: best && OPENABLE.has(state) ? best.url : null,
    label: best?.label ?? null,
    caveat: best && OPENABLE.has(state) ? best.caveat : null,
    reason,
    checkedAt: best?.checkedAt ?? null,
    lastSeen: null,
    fix: OPENABLE.has(state) ? null : fix,
    routes: svc.routes
      .filter((r) => r.viewer === viewer)
      .sort((a, b) => rank(a, viewer) - rank(b, viewer))
      .map((r) => ({ url: r.url, label: r.label, state: r.state, caveat: r.caveat, kind: r.kind })),
    localUrl: viewer === "remote" && local?.kind === "localhost" && OPENABLE.has(local.state) ? local.url : null,
    fallbackUrl: ctx.ipv4 && direct ? `${direct.scheme}://${ctx.ipv4}:${direct.port}/` : null,
    ports: svc.ports,
    pid: svc.pid,
    command: svc.command,
    cwd: svc.cwd,
  };
}

/** Pinned keys with no live service: dimmed "not running" tiles from remembered state. */
function notRunning(key: string, ctx: SelectContext): ServiceView {
  const ov = ctx.overrides.services[key] ?? {};
  const mem = ctx.remembered[key];
  const name = ov.rename?.trim() || mem?.name || key.replace(/^[^/]*\//, "");
  return {
    key, name, derivedName: mem?.name ?? name, group: mem?.group ?? "Other", project: null, branch: null, worktree: null,
    kind: "port", container: null, launchdLabel: null, pinned: true, hidden: null, state: "not_running", url: null,
    label: null, caveat: null, reason: "not running", checkedAt: null, lastSeen: mem?.lastSeen ?? null, fix: null,
    routes: [], localUrl: null, fallbackUrl: null, ports: [], pid: null, command: null, cwd: null,
  };
}

export function viewSnapshot(snap: Snapshot, viewer: Viewer, ctx: SelectContext): ServiceView[] {
  const views = snap.services.map((s) => viewService(s, viewer, ctx));
  const live = new Set(views.map((v) => v.key));
  for (const [key, ov] of Object.entries(ctx.overrides.services)) {
    if (ov.pin && !live.has(key)) views.push(notRunning(key, ctx));
  }
  return views;
}

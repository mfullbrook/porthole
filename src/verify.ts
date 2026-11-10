// Route verification: fetch the exact candidate URL from this machine (hairpin)
// and map the outcome to a state with the design's total outcome table.

import type { FetchOutcome, HttpClient } from "./http.ts";
import { extractTitle, matchSignature } from "./signatures.ts";
import type { Candidate, Route, RouteState } from "./types.ts";

export type Redirect = { kind: "loopback" } | { kind: "other"; host: string } | { kind: "too_many" };

export interface Final {
  outcome: FetchOutcome;
  redirect: Redirect | null;
}

export interface Classified {
  state: RouteState;
  caveat: string | null;
  excluded: boolean;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/**
 * The outcome table, top to bottom, first match wins. `upstreamAlive` says
 * whether any listener exists on a serve candidate's upstream port.
 */
export function classify(c: Candidate, f: Final, upstreamAlive: boolean): Classified {
  const r = (state: RouteState, caveat: string | null, excluded = false): Classified => ({ state, caveat, excluded });
  if (c.preBlocked) return r("blocked", c.preBlocked.reason);
  const o = f.outcome;
  // Refused, timeout, reset, or a TLS failure other than certificate validation
  // (certificate failures come back as a response with certError set).
  if (o.kind !== "response") return r("not_responding", "not responding");
  const serve = c.kind === "serve_https" || c.kind === "serve_http";
  if (serve && [502, 503, 504].includes(o.status) && !upstreamAlive) {
    return r("not_responding", `serve can't reach 127.0.0.1:${c.upstreamPort ?? c.port}`);
  }
  const sig = matchSignature(o.body, extractTitle(o.body));
  if (sig) return r("blocked", sig.caveat, true);
  if (f.redirect?.kind === "loopback") return r("blocked", "redirects to localhost");
  if (o.certError) return r("inferred", o.certError);
  if (f.redirect?.kind === "other") return r("inferred", `redirects to ${f.redirect.host}`);
  if (f.redirect?.kind === "too_many") return r("inferred", "too many redirects");
  const s = o.status;
  if (s >= 200 && s < 300) return r("verified", null);
  if (s === 401) return r("verified", "sign-in required");
  if (s === 403) return r("verified", null);
  if (s === 404) return r("inferred", "answers, but / is 404 (API or path-mounted)");
  if (s === 426) return r("inferred", "websocket-only port", true);
  if (s >= 400 && s < 500) return r("inferred", `answers ${s}`);
  if (serve && s === 502 && upstreamAlive) return r("inferred", `serve can't proxy to 127.0.0.1:${c.upstreamPort ?? c.port}`);
  if (s >= 500 && s < 600) return r("inferred", `${s}: app error`);
  return r("inferred", `unexpected response ${s}`);
}

export interface VerifyContext {
  http: HttpClient;
  /** Hostnames that count as "this host" for redirects: short name, FQDN, Tailscale IPs. */
  hostSet: Set<string>;
  upstreamAlive: (port: number) => boolean;
  timeoutMs?: number;
}

/** localhost candidates are fetched by address with Host: localhost:P, v4 then v6. */
async function fetchOnce(url: URL, ctx: VerifyContext): Promise<FetchOutcome> {
  const timeoutMs = ctx.timeoutMs ?? 1500;
  if (url.hostname !== "localhost") return ctx.http(url.href, { timeoutMs });
  let last: FetchOutcome = { kind: "refused" };
  for (const addr of ["127.0.0.1", "[::1]"]) {
    const u = new URL(url.href);
    u.hostname = addr;
    last = await ctx.http(u.href, { timeoutMs, host: url.host });
    if (last.kind !== "refused" && last.kind !== "timeout") return last;
  }
  return last;
}

export async function follow(c: Candidate, ctx: VerifyContext): Promise<Final> {
  let url = new URL(c.url);
  const local = c.kind === "localhost";
  for (let hops = 0; ; hops++) {
    const outcome = await fetchOnce(url, ctx);
    if (outcome.kind !== "response" || outcome.status < 300 || outcome.status >= 400 || !outcome.location) {
      return { outcome, redirect: null };
    }
    let next: URL;
    try {
      next = new URL(outcome.location, url);
    } catch {
      return { outcome, redirect: null };
    }
    const host = next.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const same = local ? host === "localhost" || LOOPBACK.test(host) : ctx.hostSet.has(host);
    if (!same && LOOPBACK.test(host)) return { outcome, redirect: { kind: "loopback" } };
    if (!same) return { outcome, redirect: { kind: "other", host: next.host } };
    if (hops >= 3) return { outcome, redirect: { kind: "too_many" } };
    url = next;
  }
}

export async function verify(c: Candidate, ctx: VerifyContext, now = Date.now()): Promise<Route> {
  const upstreamAlive = ctx.upstreamAlive(c.upstreamPort ?? c.port);
  const final: Final = c.preBlocked ? { outcome: { kind: "refused" }, redirect: null } : await follow(c, ctx);
  return { ...c, ...classify(c, final, upstreamAlive), checkedAt: now };
}

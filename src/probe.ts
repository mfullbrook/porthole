// Identity probe: scheme, status, <title> and favicon for one listener, fetched
// over loopback (or the bound address). Cached per (pid, port, start time) only
// when it succeeds; failures back off.

import { urlHost, type FetchOutcome, type HttpClient } from "./http.ts";
import { extractFavicon, extractTitle, matchSignature } from "./signatures.ts";
import type { Listener, ProbeResult } from "./types.ts";

/** The address porthole probes a listener on (never a denied one). */
export function probeAddress(l: Listener): string {
  const kinds = new Set(l.binds.map((b) => b.kind));
  if (kinds.has("loopback4") || kinds.has("wildcard4")) return "127.0.0.1";
  if (kinds.has("loopback6") || kinds.has("wildcard6")) return "::1";
  const b = l.binds.find((x) => x.kind === "tailscale4") ?? l.binds.find((x) => x.kind === "tailscale6") ?? l.binds[0];
  return b?.addr ?? "127.0.0.1";
}

const HTTPS_HINT = /HTTP request was sent to HTTPS port|plain HTTP request|speaking plain HTTP to an SSL/i;

function isHtml(o: Extract<FetchOutcome, { kind: "response" }>): boolean {
  return /html/i.test(o.contentType ?? "") || /^\s*<(!doctype html|html)/i.test(o.body);
}

function failed(error: string, scheme: ProbeResult["scheme"] = null, status: number | null = null): ProbeResult {
  return { ok: false, scheme, status, title: null, html: false, favicon: null, blockedSignature: null, error };
}

async function getFollowing(http: HttpClient, url: string, insecure: boolean): Promise<FetchOutcome> {
  // Follow same-origin redirects (e.g. "/" → "/login") so the title is the app's.
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const o = await http(current, { insecure, timeoutMs: 1500 });
    if (o.kind !== "response" || o.status < 300 || o.status >= 400 || !o.location) return o;
    const next = new URL(o.location, current);
    if (next.origin !== new URL(current).origin) return o;
    current = next.href;
  }
  return http(current, { insecure, timeoutMs: 1500 });
}

/** `path`: probe a serve mapping's upstream path (e.g. an app mounted at /rc whose / is a JSON 404). */
export async function identityProbe(l: Listener, http: HttpClient, path = "/"): Promise<ProbeResult> {
  const base = `${urlHost(probeAddress(l))}:${l.port}${path.startsWith("/") ? "" : "/"}`;
  let scheme: "http" | "https" = "http";
  let o = await getFollowing(http, `http://${base}${path}`, false);
  const tlsish =
    o.kind === "reset" || o.kind === "tls" || o.kind === "error" ||
    (o.kind === "response" && o.status === 400 && HTTPS_HINT.test(o.body));
  if (tlsish) {
    const s = await getFollowing(http, `https://${base}${path}`, true);
    if (s.kind === "response") {
      o = s;
      scheme = "https";
    }
  }
  if (o.kind !== "response") return failed(o.kind === "refused" || o.kind === "timeout" ? o.kind : o.message);
  if (o.status >= 500) return failed(`HTTP ${o.status}`, scheme, o.status);
  const html = isHtml(o);
  const title = html ? extractTitle(o.body) : null;
  return {
    ok: true,
    scheme,
    status: o.status,
    title,
    html,
    favicon: html ? extractFavicon(o.body) : null,
    blockedSignature: matchSignature(o.body, title)?.id ?? null,
    error: null,
  };
}

/** Retry schedule after the Nth consecutive failure (1-based). */
export function backoffMs(failures: number): number {
  if (failures <= 1) return 0; // next scan
  if (failures === 2) return 30_000;
  if (failures === 3) return 120_000;
  return 600_000;
}

/** Once retries reach the 10-minute cadence the listener is "no HTTP response". */
export function gaveUp(failures: number): boolean {
  return backoffMs(failures) >= 600_000;
}

export interface ProbeEntry {
  result: ProbeResult | null; // last success, kept until the listener disappears
  failures: number;
  nextAt: number;
  lastError: string | null;
}

export class ProbeCache {
  private entries = new Map<string, ProbeEntry>();

  static key(pid: number, port: number, lstart: string): string {
    return `${pid}:${port}:${lstart}`;
  }

  get(key: string): ProbeEntry | undefined {
    return this.entries.get(key);
  }

  due(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !e || (!e.result && now >= e.nextAt);
  }

  record(key: string, r: ProbeResult, now: number): void {
    const prev = this.entries.get(key);
    if (r.ok) {
      this.entries.set(key, { result: r, failures: 0, nextAt: Infinity, lastError: null });
      return;
    }
    const failures = (prev?.failures ?? 0) + 1;
    this.entries.set(key, { result: null, failures, nextAt: now + backoffMs(failures), lastError: r.error });
  }

  /** Drop entries for listeners that no longer exist. */
  retain(live: Set<string>): void {
    for (const k of this.entries.keys()) if (!live.has(k)) this.entries.delete(k);
  }
}

// The scan loop: collect → deny → probe → aggregate → candidates → verify →
// snapshot. Requests read the last completed snapshot; only ?fresh=1 waits.

import { gaveUp, identityProbe, ProbeCache } from "./probe.ts";
import { candidateKey, denyMap, fixesFor, listenersOf, resolve, verifyAll, type ResolveOptions } from "./resolve.ts";
import type { ProbeState, ServiceDraft } from "./aggregate.ts";
import type { HttpClient } from "./http.ts";
import type { Collected, Fix, Listener, Route, Snapshot } from "./types.ts";
import type { Overrides } from "./select.ts";
import { bestRoute } from "./select.ts";
import type { StateStore } from "./state.ts";

export interface ScannerDeps {
  collect: () => Promise<Collected>;
  http: HttpClient;
  overrides: () => Overrides;
  state: StateStore | null;
  opts: ResolveOptions;
  now?: () => number;
  log?: (msg: string) => void;
}

export const ACTIVE_INTERVAL = 10_000;
export const IDLE_INTERVAL = 60_000;
export const CLIENT_ACTIVE_MS = 60_000;
export const KICK_AFTER_MS = 15_000;
export const STALE_AFTER_MS = 90_000; // above the idle interval + scan budget
const VERIFY_EVERY_MS = 60_000;
const PROBE_BUDGET_MS = 3_000;
const PROBE_CONCURRENCY = 8;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Scanner {
  snapshot: Snapshot | null = null;
  fixes = new Map<string, { remote: Fix | null; local: Fix | null }>();
  lastError: string | null = null;
  lastScanFailed = false;

  private probes = new ProbeCache();
  private inflight = new Map<string, Promise<void>>();
  private routes = new Map<string, Route>();
  private verifySignature = "";
  private lastVerifyAt = 0;
  private lastClientAt = 0;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private now: () => number;

  constructor(private deps: ScannerDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    void this.scanNow().finally(() => this.schedule());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private clientActive(): boolean {
    return this.now() - this.lastClientAt < CLIENT_ACTIVE_MS;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.scanNow().finally(() => this.schedule());
    }, this.clientActive() ? ACTIVE_INTERVAL : IDLE_INTERVAL);
  }

  /** A client asked for /api/services: switch to the active cadence, kick a stale snapshot. */
  touch(): void {
    const wasIdle = !this.clientActive();
    this.lastClientAt = this.now();
    if (!this.snapshot || this.now() - this.snapshot.scannedAt > KICK_AFTER_MS) void this.scanNow();
    else if (wasIdle) this.schedule();
  }

  isStale(): boolean {
    if (!this.snapshot) return this.lastScanFailed;
    return this.lastScanFailed || this.now() - this.snapshot.scannedAt > STALE_AFTER_MS;
  }

  /** Start a scan (or join the running one). */
  scanNow(): Promise<void> {
    if (!this.running) {
      this.running = this.scanOnce()
        .catch((e) => {
          this.lastError = (e as Error).message ?? String(e);
          this.lastScanFailed = true;
          this.deps.log?.(`scan failed: ${this.lastError}`);
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  /** ?fresh=1: wait up to `ms` for a new scan. */
  async fresh(ms = 3000): Promise<void> {
    await Promise.race([this.scanNow(), sleep(ms)]);
  }

  private probePath(c: Collected, l: Listener): string {
    const m = (c.serve ?? []).find((x) => x.upstream?.port === l.port && x.upstream.path);
    return m?.upstream?.path || "/";
  }

  private async runProbes(c: Collected, listeners: Listener[], deny: Map<string, string>): Promise<Map<string, ProbeState>> {
    const now = this.now();
    const live = new Set<string>();
    const due: { key: string; l: Listener }[] = [];
    for (const l of listeners) {
      const key = ProbeCache.key(l.pid, l.port, c.processes.get(l.pid)?.lstart ?? "");
      live.add(key);
      if (deny.has(`${l.pid}:${l.port}`)) continue;
      if (this.probes.due(key, now) && !this.inflight.has(key)) due.push({ key, l });
    }
    // Bounded concurrency; probes that miss the scan budget keep running and land next scan.
    let i = 0;
    const worker = async () => {
      while (i < due.length) {
        const { key, l } = due[i++]!;
        const p = identityProbe(l, this.deps.http, this.probePath(c, l))
          .then((r) => this.probes.record(key, r, this.now()))
          .catch((e) => this.probes.record(key, { ok: false, scheme: null, status: null, title: null, html: false, favicon: null, blockedSignature: null, error: String(e) }, this.now()))
          .finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        await p;
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, due.length) }, worker));
    await Promise.race([all, sleep(PROBE_BUDGET_MS)]);
    this.probes.retain(new Set([...live, ...this.inflight.keys()]));

    const states = new Map<string, ProbeState>();
    for (const l of listeners) {
      const e = this.probes.get(ProbeCache.key(l.pid, l.port, c.processes.get(l.pid)?.lstart ?? ""));
      const k = `${l.pid}:${l.port}`;
      if (e?.result) states.set(k, { state: "ok", result: e.result });
      else if (e && gaveUp(e.failures)) states.set(k, { state: "no_http", result: null });
      else states.set(k, { state: "identifying", result: null });
    }
    return states;
  }

  private async scanOnce(): Promise<void> {
    const started = this.now();
    const c = await this.deps.collect();
    const listeners = listenersOf(c);
    const deny = denyMap(c, listeners, this.deps.opts.selfPid);
    const probeStates = await this.runProbes(c, listeners, deny);
    const r = resolve(c, probeStates, this.deps.opts);
    const ov = this.deps.overrides();
    const skip = (d: ServiceDraft) => {
      const h = ov.services[d.key]?.hide;
      return h === true || (!!d.hidden && h !== false);
    };

    // Re-verify everything when listeners, serve config or schemes change, and
    // every 60s while a client is active; otherwise only new candidates.
    const signature = JSON.stringify([
      listeners.map((l) => `${l.pid}:${l.port}:${probeStates.get(`${l.pid}:${l.port}`)?.result?.scheme ?? ""}`),
      c.serve,
    ]);
    const full = signature !== this.verifySignature || (this.clientActive() && started - this.lastVerifyAt > VERIFY_EVERY_MS);
    const results = await verifyAll(r, { http: this.deps.http, skip, now: started, reuse: full ? undefined : this.routes });
    if (full) {
      this.verifySignature = signature;
      this.lastVerifyAt = started;
    }
    this.routes = results;

    this.fixes = fixesFor(r);
    const ts = c.tailscale;
    this.snapshot = {
      scannedAt: this.now(),
      verifiedAt: this.lastVerifyAt || null,
      host: ts?.hostName || this.deps.opts.host,
      fqdn: ts?.fqdn || null,
      tailscaleIPv4: ts?.ips.find((ip) => !ip.includes(":")) ?? null,
      ownerLogin: ts?.ownerLogin ?? null,
      services: r.drafts,
      warnings: c.warnings,
      error: null,
    };
    this.lastScanFailed = false;
    this.lastError = null;

    const state = this.deps.state;
    if (state) {
      for (const d of r.drafts) {
        if (d.hidden && ov.services[d.key]?.hide !== false) continue;
        state.see(d.key, d.name, d.group, bestRoute(d.routes, "remote")?.url ?? null, this.snapshot.scannedAt);
      }
      state.flush(this.snapshot.scannedAt);
    }
    this.deps.log?.(`scan ${r.drafts.length} services in ${this.now() - started}ms${full ? " (verified)" : ""}`);
  }
}

// One test per row of the outcome table (design: "Verification rules"), plus
// redirects, ranking and probe scheme detection.

import { describe, expect, test } from "bun:test";
import { classify, follow, type Final } from "../src/verify.ts";
import { bestRoute, rank } from "../src/select.ts";
import { identityProbe, backoffMs, gaveUp, ProbeCache } from "../src/probe.ts";
import type { FetchOutcome } from "../src/http.ts";
import type { Candidate, Route } from "../src/types.ts";
import { res, scripted } from "./helpers.ts";

const direct: Candidate = { url: "http://mac-mini:3000/", label: "mac-mini:3000", kind: "direct", port: 3000, viewer: "remote" };
const serve: Candidate = { url: "https://h.ts.net:6006/", label: "serve :6006", kind: "serve_https", port: 6006, upstreamPort: 6006, viewer: "remote" };
const f = (outcome: FetchOutcome, redirect: Final["redirect"] = null): Final => ({ outcome, redirect });
const c = (cand: Candidate, fin: Final, alive = true) => {
  const r = classify(cand, fin, alive);
  return [r.state, r.caveat];
};

describe("outcome table", () => {
  test("pre-fetch address-family mismatch → blocked, before anything else", () => {
    const pre = { ...serve, preBlocked: { reason: "serve points at 127.0.0.1:5173, app is on [::1]" } };
    expect(c(pre, f(res(502)), false)).toEqual(["blocked", "serve points at 127.0.0.1:5173, app is on [::1]"]);
  });
  test("refused / timeout / reset / TLS handshake → not responding", () => {
    for (const o of [{ kind: "refused" }, { kind: "timeout" }, { kind: "reset", message: "" }, { kind: "tls", message: "" }] as FetchOutcome[]) {
      expect(c(direct, f(o))).toEqual(["not_responding", "not responding"]);
    }
  });
  test("serve 502/503/504 with no upstream listener → not responding", () => {
    for (const s of [502, 503, 504]) expect(c(serve, f(res(s)), false)).toEqual(["not_responding", "serve can't reach 127.0.0.1:6006"]);
  });
  test("serve 502 with a live upstream → inferred, serve's error not the app's", () => {
    expect(c(serve, f(res(502)), true)).toEqual(["inferred", "serve can't proxy to 127.0.0.1:6006"]);
  });
  test("blocked signatures", () => {
    expect(c(direct, f(res(403, 'Blocked request. This host ("mac-mini") is not allowed.')))).toEqual(["blocked", "host not allowed"]);
    expect(c(direct, f(res(400, "Invalid Host header")))).toEqual(["blocked", "host not allowed"]);
    expect(c(direct, f(res(404, "<title>Laravel Vite</title>")))).toEqual(["blocked", "not the app: Vite asset server"]);
    expect(classify(direct, f(res(403, 'Blocked request. This host ("x") is not allowed.')), true).excluded).toBe(true);
  });
  test("redirect to loopback → blocked", () => {
    expect(c(direct, f(res(302), { kind: "loopback" }))).toEqual(["blocked", "redirects to localhost"]);
  });
  test("certificate failure caps at inferred, even for a 200", () => {
    expect(c(direct, f(res(200, "", { certError: "self-signed certificate" })))).toEqual(["inferred", "self-signed certificate"]);
    expect(c(direct, f(res(401, "", { certError: "certificate expired" })))).toEqual(["inferred", "certificate expired"]);
  });
  test("2xx / 401 / 403 → verified", () => {
    expect(c(direct, f(res(204)))).toEqual(["verified", null]);
    expect(c(direct, f(res(401)))).toEqual(["verified", "sign-in required"]);
    expect(c(direct, f(res(403, "Forbidden")))).toEqual(["verified", null]);
  });
  test("redirect elsewhere / too many → inferred", () => {
    expect(c(direct, f(res(302), { kind: "other", host: "accounts.google.com" }))).toEqual(["inferred", "redirects to accounts.google.com"]);
    expect(c(direct, f(res(302), { kind: "too_many" }))).toEqual(["inferred", "too many redirects"]);
  });
  test("404 / 426 / other 4xx / 5xx / anything else → inferred", () => {
    expect(c(direct, f(res(404)))).toEqual(["inferred", "answers, but / is 404 (API or path-mounted)"]);
    expect(classify(direct, f(res(426)), true)).toEqual({ state: "inferred", caveat: "websocket-only port", excluded: true });
    expect(c(direct, f(res(405)))).toEqual(["inferred", "answers 405"]);
    expect(c(direct, f(res(500)))).toEqual(["inferred", "500: app error"]);
    expect(c(direct, f(res(304)))).toEqual(["inferred", "unexpected response 304"]);
  });
});

describe("redirect following", () => {
  const ctx = (routes: Record<string, FetchOutcome>) => ({ http: scripted(routes), hostSet: new Set(["mac-mini", "mac-mini.t.ts.net", "100.1.2.3"]), upstreamAlive: () => true });

  test("follows up to 3 hops on this host", async () => {
    const fin = await follow(direct, ctx({
      "http://mac-mini:3000/": res(302, "", { location: "/a" }),
      "http://mac-mini:3000/a": res(302, "", { location: "http://mac-mini.t.ts.net:3000/b" }),
      "http://mac-mini.t.ts.net:3000/b": res(200),
    }));
    expect(fin.redirect).toBeNull();
    expect(fin.outcome).toMatchObject({ status: 200 });
  });
  test("more than 3 hops → too many", async () => {
    const loop = res(302, "", { location: "/" });
    expect((await follow(direct, ctx({ "http://mac-mini:3000/": loop }))).redirect).toEqual({ kind: "too_many" });
  });
  test("to localhost → loopback; elsewhere → stops without fetching", async () => {
    expect((await follow(direct, ctx({ "http://mac-mini:3000/": res(302, "", { location: "http://localhost:3000/" }) }))).redirect).toEqual({ kind: "loopback" });
    const x = ctx({ "http://mac-mini:3000/": res(302, "", { location: "https://idp.example/login" }) });
    expect((await follow(direct, x)).redirect).toEqual({ kind: "other", host: "idp.example" });
    expect(x.http.calls).toEqual(["http://mac-mini:3000/"]);
  });
  test("localhost candidates try 127.0.0.1 then ::1 with Host: localhost:P", async () => {
    const x = ctx({ "http://[::1]:5173/|localhost:5173": res(200) });
    const fin = await follow({ ...direct, url: "http://localhost:5173/", kind: "localhost", port: 5173, viewer: "local" }, x);
    expect(fin.outcome).toMatchObject({ status: 200 });
    expect(x.http.calls).toEqual(["http://127.0.0.1:5173/|localhost:5173", "http://[::1]:5173/|localhost:5173"]);
  });
});

describe("ranking", () => {
  const route = (kind: Route["kind"], state: Route["state"], port = 1, viewer: Route["viewer"] = "remote", excluded = false): Route =>
    ({ url: `${kind}-${state}-${port}`, label: "", kind, port, viewer, state, caveat: null, checkedAt: 0, excluded });

  test("verified serve https > verified direct > verified serve http > inferred > blocked > not responding", () => {
    const order = [
      route("serve_https", "verified"), route("direct", "verified"), route("serve_http", "verified"),
      route("serve_https", "inferred"), route("direct", "inferred"), route("serve_http", "inferred"),
      route("direct", "blocked"), route("direct", "not_responding"),
    ];
    const ranks = order.map((r) => rank(r, "remote"));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
  test("local viewer: verified localhost first", () => {
    expect(bestRoute([route("serve_https", "verified", 1, "local"), route("localhost", "verified", 1, "local")], "local")!.kind).toBe("localhost");
  });
  test("excluded ports lose unless every port is excluded (lowest port on ties)", () => {
    const a = route("direct", "verified", 5174, "remote", true);
    const b = route("direct", "inferred", 5175);
    expect(bestRoute([a, b], "remote")).toBe(b);
    const c2 = route("direct", "blocked", 5173, "remote", true);
    const d = route("direct", "blocked", 5174, "remote", true);
    expect(bestRoute([d, c2], "remote")).toBe(c2);
  });
});

describe("identity probe", () => {
  const l = { pid: 1, port: 8443, command: "node", binds: [{ addr: "*", family: "IPv6" as const, kind: "wildcard6" as const }] };

  test("falls back to https when plain http gets an empty reply", async () => {
    const http = scripted({
      "http://[::1]:8443/": { kind: "reset", message: "ECONNRESET" },
      "https://[::1]:8443/": res(200, "<title>Live Captions</title>"),
    });
    expect(await identityProbe(l, http)).toMatchObject({ ok: true, scheme: "https", title: "Live Captions" });
  });
  test("5xx is not a success (retried), <500 is", async () => {
    expect((await identityProbe(l, scripted({ "http://[::1]:8443/": res(503) }))).ok).toBe(false);
    expect((await identityProbe(l, scripted({ "http://[::1]:8443/": res(404, "<title>x</title>") }))).ok).toBe(true);
  });
  test("follows a same-origin redirect for the title", async () => {
    const http = scripted({ "http://[::1]:8443/": res(307, "", { location: "/login" }), "http://[::1]:8443/login": res(200, "<title>Sign in</title>") });
    expect((await identityProbe(l, http)).title).toBe("Sign in");
  });
  test("backoff: next scan, 30s, 2m, then 10m (gave up)", () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([0, 30_000, 120_000, 600_000, 600_000]);
    expect(gaveUp(3)).toBe(false);
    expect(gaveUp(4)).toBe(true);
  });
  test("cache keeps only successes; a new start time is a new listener", () => {
    const cache = new ProbeCache();
    const k = ProbeCache.key(1, 80, "t0");
    cache.record(k, { ok: false, scheme: null, status: 503, title: null, html: false, favicon: null, blockedSignature: null, error: "HTTP 503" }, 0);
    expect(cache.due(k, 0)).toBe(true);
    cache.record(k, { ok: false, scheme: null, status: 503, title: null, html: false, favicon: null, blockedSignature: null, error: "x" }, 0);
    expect(cache.due(k, 10_000)).toBe(false);
    expect(cache.due(k, 30_000)).toBe(true);
    cache.record(k, { ok: true, scheme: "http", status: 200, title: "x", html: true, favicon: null, blockedSignature: null, error: null }, 0);
    expect(cache.due(k, 1e12)).toBe(false);
    expect(cache.due(ProbeCache.key(1, 80, "t1"), 0)).toBe(true);
  });
});

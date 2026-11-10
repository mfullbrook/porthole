// Listener gates (design: "Origins and trust boundary") and the overrides write path.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { OverridesStore } from "../src/overrides.ts";
import { Scanner } from "../src/scanner.ts";
import { makeHandler, type ServerDeps } from "../src/server.ts";
import { FQDN, OPTS, scannerHttp, loadFixture } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "porthole-test-"));
const web = join(dir, "web");
mkdirSync(web);
writeFileSync(join(web, "index.html"), '<meta name="porthole-csrf" content="__PORTHOLE_CSRF__"><script src="/static/app.js"></script>');
writeFileSync(join(web, "app.js"), "console.log(1)");
writeFileSync(join(web, "dev-server.ts"), "secret");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cfg: Config = { ...DEFAULT_CONFIG, portA: 7450, fqdn: null };
const A = `${FQDN}:7443`;
const OWNER = "alice@github";
const CSRF = "test-csrf-token";

async function deps(opts: { scanned?: boolean; owner?: string | null } = {}): Promise<ServerDeps> {
  const overrides = new OverridesStore(join(dir, `overrides-${Math.random()}.json`));
  const fixture = loadFixture();
  if (opts.owner !== undefined && fixture.tailscale) fixture.tailscale.ownerLogin = opts.owner;
  const scanner = new Scanner({ collect: async () => fixture, http: scannerHttp(), overrides: () => overrides.get(), state: null, opts: OPTS });
  if (opts.scanned !== false) await scanner.scanNow();
  scanner.touch = () => {};
  return { cfg, scanner, overrides, state: null, webDir: web, csrf: CSRF };
}

const get = (host: string, path = "/", headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1${path}`, { headers: { host, ...headers } });

const put = (host: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1/api/overrides", {
    method: "PUT",
    headers: { host, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("listener A (remote, via serve)", async () => {
  const d = await deps();
  const h = makeHandler("A", d);
  const owner = { "tailscale-user-login": OWNER };

  test("owner gets the page with the CSRF token substituted", async () => {
    const r = await h(get(A, "/", owner));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(`content="${CSRF}"`);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
  test(":443 / (bare FQDN) is a data-free 302 to the porthole origin", async () => {
    for (const path of ["/", "/api/services"]) {
      const r = await h(get(FQDN, path));
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`https://${A}/`);
      expect(await r.text()).toBe("");
    }
  });
  test("foreign Host → 421 (DNS rebinding)", async () => {
    for (const host of ["evil.example", "127.0.0.1:7450", `${FQDN}:8443`, "localhost:7444"]) {
      expect((await h(get(host, "/api/services", owner))).status).toBe(421);
    }
  });
  test("missing or non-owner Tailscale-User-Login → 403", async () => {
    expect((await h(get(A, "/api/services"))).status).toBe(403);
    expect((await h(get(A, "/api/services", { "tailscale-user-login": "friend@github" }))).status).toBe(403);
    expect((await h(get(A, "/", { "tailscale-user-login": "" }))).status).toBe(403);
  });
  test("OPTIONS → 405, no CORS", async () => {
    const r = await h(new Request("http://x/api/overrides", { method: "OPTIONS", headers: { host: A, origin: "https://evil.example", ...owner } }));
    expect(r.status).toBe(405);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
  test("/api/services returns the remote view plus csrf and etag", async () => {
    const body = await (await h(get(A, "/api/services", owner))).json();
    expect(body).toMatchObject({ viewer: "remote", fqdn: FQDN, scanning: false, csrf: CSRF });
    expect(body.overridesEtag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(body.services.find((s: { name: string }) => s.name === "Open WebUI").url).toBe(`https://${FQDN}:6006/`);
  });
  test("static files: flat allowlist, never the dev server or traversal", async () => {
    expect((await h(get(A, "/static/app.js", owner))).status).toBe(200);
    expect((await h(get(A, "/static/dev-server.ts", owner))).status).toBe(404);
    expect((await h(get(A, "/static/..%2Fpackage.json", owner))).status).toBe(404);
    expect((await h(get(A, "/static/.env", owner))).status).toBe(404);
  });

  describe("PUT /api/overrides", () => {
    let etag = "";
    const good = () => ({ origin: `https://${A}`, "x-porthole-csrf": CSRF, "if-match": etag, ...owner });
    const key = "mac-mini/docker:open-webui-hermes";
    beforeEach(async () => {
      etag = (await (await h(get(A, "/api/services", owner))).json()).overridesEtag;
    });

    test("pins with all gates satisfied, then the view shows it", async () => {
      const r = await h(put(A, { key, set: { pin: true, rename: "  WebUI " } }, good()));
      expect(r.status).toBe(200);
      const view = await (await h(get(A, "/api/services", owner))).json();
      expect(view.services.find((s: { key: string }) => s.key === key)).toMatchObject({ pinned: true, name: "WebUI" });
      expect(view.overridesEtag).toBe((await r.json()).etag);
    });
    test("stale If-Match → 409; missing → 428", async () => {
      expect((await h(put(A, { key, set: { pin: false } }, { ...good(), "if-match": '"0000000000000000"' }))).status).toBe(409);
      const { "if-match": _, ...noIfMatch } = good();
      expect((await h(put(A, { key, set: { pin: false } }, noIfMatch))).status).toBe(428);
    });
    test("foreign or missing Origin → 403", async () => {
      expect((await h(put(A, { key, set: { pin: true } }, { ...good(), origin: "https://evil.example" }))).status).toBe(403);
      expect((await h(put(A, { key, set: { pin: true } }, { ...good(), origin: `https://${FQDN}` }))).status).toBe(403);
      const { origin: _, ...noOrigin } = good();
      expect((await h(put(A, { key, set: { pin: true } }, noOrigin))).status).toBe(403);
    });
    test("missing or wrong CSRF token → 403", async () => {
      expect((await h(put(A, { key, set: { pin: true } }, { ...good(), "x-porthole-csrf": "nope" }))).status).toBe(403);
      const { "x-porthole-csrf": _, ...noCsrf } = good();
      expect((await h(put(A, { key, set: { pin: true } }, noCsrf))).status).toBe(403);
    });
    test("non-owner → 403 even with a valid token", async () => {
      expect((await h(put(A, { key, set: { pin: true } }, { ...good(), "tailscale-user-login": "friend@github" }))).status).toBe(403);
    });
    test("non-JSON content type → 415; bad schema → 400; too large → 413", async () => {
      expect((await h(put(A, { key, set: { pin: true } }, { ...good(), "content-type": "text/plain" }))).status).toBe(415);
      expect((await h(put(A, { key, set: { pin: "yes" } }, good()))).status).toBe(400);
      expect((await h(put(A, { key, set: { evil: 1 } }, good()))).status).toBe(400);
      expect((await h(put(A, { key: "", set: {} }, good()))).status).toBe(400);
      expect((await h(put(A, { key, set: { rename: "x".repeat(500) } }, good()))).status).toBe(400);
      expect((await h(put(A, JSON.stringify({ key, set: {}, pad: "x".repeat(70_000) }), good()))).status).toBe(413);
    });
    test("GET on the write path → 405", async () => {
      expect((await h(get(A, "/api/overrides", owner))).status).toBe(405);
    });
  });
});

describe("listener A before Tailscale is known", () => {
  test("no snapshot and no saved FQDN → 503 waiting for Tailscale", async () => {
    const h = makeHandler("A", await deps({ scanned: false }));
    const r = await h(get(A, "/", { "tailscale-user-login": OWNER }));
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("waiting for Tailscale");
  });
  test("owner unknown (tagged node / not connected) → 503, and an empty login never matches", async () => {
    const h = makeHandler("A", await deps({ owner: null }));
    expect((await h(get(A, "/", { "tailscale-user-login": OWNER }))).status).toBe(503);
    expect((await h(get(A, "/", { "tailscale-user-login": "" }))).status).toBe(503);
  });
});

describe("listener B (this Mac)", async () => {
  const d = await deps();
  const h = makeHandler("B", d);

  test("localhost and 127.0.0.1 on the local port only; identity headers ignored", async () => {
    expect((await h(get("localhost:7444", "/api/services"))).status).toBe(200);
    expect((await h(get("127.0.0.1:7444", "/api/services"))).status).toBe(200);
    expect((await h(get(A, "/api/services", { "tailscale-user-login": OWNER }))).status).toBe(421);
    expect((await h(get("localhost:7443", "/api/services"))).status).toBe(421);
    expect((await h(get("mac-mini:7444", "/api/services"))).status).toBe(421);
  });
  test("local view: localhost URLs are primary", async () => {
    const body = await (await h(get("localhost:7444", "/api/services"))).json();
    expect(body.viewer).toBe("local");
    expect(body.services.find((s: { name: string }) => s.name === "Puzzle Game")).toMatchObject({ state: "verified", url: "http://localhost:5173/" });
  });
  test("PUT still requires the B origin and the CSRF token", async () => {
    const etag = (await (await h(get("localhost:7444", "/api/services"))).json()).overridesEtag;
    const base = { "x-porthole-csrf": CSRF, "if-match": etag };
    expect((await h(put("localhost:7444", { key: "k", set: { hide: true } }, { ...base, origin: `https://${A}` }))).status).toBe(403);
    expect((await h(put("localhost:7444", { key: "k", set: { hide: true } }, { ...base, origin: "http://localhost:7444", "x-porthole-csrf": "x" }))).status).toBe(403);
    const ok = await h(put("localhost:7444", { key: "k", set: { hide: true } }, { ...base, origin: "http://localhost:7444" }));
    expect(ok.status).toBe(200);
  });
});

describe("overrides file", () => {
  test("writes are atomic JSON and a hand edit changes the etag", () => {
    const f = join(dir, "ov.json");
    const s = new OverridesStore(f);
    const e1 = s.etag;
    const e2 = s.update(e1, { key: "a", set: { pin: true } })!;
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ version: 1, services: { a: { pin: true } } });
    expect(s.update(e1, { key: "a", set: { pin: false } })).toBeNull(); // stale etag
    writeFileSync(f, JSON.stringify({ version: 1, services: { b: { hide: true } } }));
    expect(s.etag).toBe(e2);
    s.get();
    expect(s.etag).not.toBe(e2);
    expect(s.get().services).toEqual({ b: { hide: true } });
  });
  test("clearing every field removes the entry", () => {
    const s = new OverridesStore(join(dir, "ov2.json"));
    const e = s.update(s.etag, { key: "a", set: { pin: true, rename: "X" } })!;
    s.update(e, { key: "a", set: { pin: null, rename: "" } });
    expect(s.get().services).toEqual({});
  });
});

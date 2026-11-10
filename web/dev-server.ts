// Development-only static server for the launcher page. Not used by the daemon.
//   ~/.bun/bin/bun web/dev-server.ts            (PORT=7499, PORTHOLE_VIEWER=remote by default)
// Page query params (remembered in a cookie so the page's own /api/services calls pick them up):
//   ?viewer=local|remote   which fixture to serve
//   ?scenario=stale|scanning|warnings|none
// Dev-only helpers: POST /dev/rotate-csrf (next PUT gets 403 until a refetch), POST /dev/bump-etag (next PUT gets 409).

import { join, normalize } from "node:path";

const ROOT = import.meta.dir;
const FIXTURES = join(ROOT, "..", "test", "fixtures");
const PORT = Number(process.env.PORT || 7499);
const DEFAULT_VIEWER = process.env.PORTHOLE_VIEWER === "local" ? "local" : "remote";

type Viewer = "remote" | "local";
type Json = Record<string, any>;

const data: Record<Viewer, Json> = {
  remote: await Bun.file(join(FIXTURES, "api-services.remote.json")).json(),
  local: await Bun.file(join(FIXTURES, "api-services.local.json")).json(),
};
const originalHidden = new Map<string, string | null>(data.remote.services.map((s: Json) => [s.key, s.hidden]));
let csrf = "dev";
let etagN = 1;
const etag = () => `"dev-${etagN}"`;

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function servicesResponse(viewer: Viewer, scenario: string, fresh: boolean): Json {
  const src = structuredClone(data[viewer]);
  const now = Date.now();
  const delta = now - 3000 - src.scannedAt; // make the sample look like a scan from 3s ago
  const shift = (v: number | null) => (typeof v === "number" ? v + delta : v);
  src.scannedAt = shift(src.scannedAt);
  src.verifiedAt = shift(src.verifiedAt);
  for (const s of src.services) { s.checkedAt = shift(s.checkedAt); s.lastSeen = shift(s.lastSeen); }
  src.csrf = csrf;
  src.overridesEtag = etag();
  if (scenario === "stale" && !fresh) {
    src.stale = true;
    src.scannedAt = now - 5 * 60_000;
    src.error = "lsof failed: exit status 1";
  }
  if (scenario === "scanning") { src.scanning = true; src.scannedAt = null; src.verifiedAt = null; src.services = []; }
  if (scenario === "warnings") {
    src.warnings = [
      { source: "docker", message: "docker unavailable: containers shown by port only" },
      { source: "git", message: "git failed for 2 worktrees: branch names may be missing" },
    ];
  }
  return src;
}

function applyOverride(key: string, set: Json): boolean {
  let found = false;
  for (const viewer of ["remote", "local"] as Viewer[]) {
    const list: Json[] = data[viewer].services;
    const i = list.findIndex((s) => s.key === key);
    if (i < 0) continue;
    found = true;
    const s = list[i]!;
    if ("pin" in set) {
      s.pinned = set.pin === true;
      if (!s.pinned && s.state === "not_running") { list.splice(i, 1); continue; }
    }
    if ("rename" in set) s.name = typeof set.rename === "string" && set.rename.trim() ? set.rename.trim() : s.derivedName;
    if ("hide" in set) s.hidden = set.hide === true ? "hidden by you" : set.hide === false ? null : originalHidden.get(key) ?? null;
  }
  return found;
}

function staticFile(name: string): Response {
  const path = normalize(join(ROOT, name));
  if (!path.startsWith(ROOT + "/") || name.includes("..") || name.endsWith(".ts")) return new Response("not found", { status: 404 });
  const f = Bun.file(path);
  return new Response(f, { headers: { "Cache-Control": "no-store", ...(name.endsWith(".webmanifest") ? { "Content-Type": "application/manifest+json" } : {}) } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const c = cookies(req);
    const viewer: Viewer = (url.searchParams.get("viewer") || c.pv || DEFAULT_VIEWER) === "local" ? "local" : "remote";
    const scenario = url.searchParams.get("scenario") ?? c.ps ?? "none";

    if (req.method === "GET" && url.pathname === "/") {
      const html = (await Bun.file(join(ROOT, "index.html")).text()).replaceAll("__PORTHOLE_CSRF__", "dev");
      const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      if (url.searchParams.has("viewer")) headers.append("Set-Cookie", `pv=${viewer}; Path=/; SameSite=Strict`);
      if (url.searchParams.has("scenario")) headers.append("Set-Cookie", `ps=${encodeURIComponent(scenario)}; Path=/; SameSite=Strict`);
      return new Response(html, { headers });
    }
    if (req.method === "GET" && url.pathname.startsWith("/static/")) return staticFile(url.pathname.slice(8));
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") return staticFile("manifest.webmanifest");
    if (req.method === "GET" && url.pathname === "/apple-touch-icon.png") return staticFile("apple-touch-icon.png");

    if (req.method === "GET" && url.pathname === "/api/services") {
      const fresh = url.searchParams.get("fresh") === "1";
      if (fresh) await Bun.sleep(600);
      return Response.json(servicesResponse(viewer, scenario, fresh), { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/overrides") {
      if (req.method !== "PUT") return new Response("method not allowed", { status: 405 });
      if (!(req.headers.get("content-type") || "").startsWith("application/json")) return new Response("not JSON", { status: 415 });
      if (req.headers.get("x-porthole-csrf") !== csrf) return new Response("csrf rejected", { status: 403 });
      if (req.headers.get("if-match") !== etag()) return new Response("changed elsewhere", { status: 409 });
      let body: Json;
      try { body = await req.json(); } catch { return new Response("bad JSON", { status: 400 }); }
      if (!body || typeof body.key !== "string" || !body.set || typeof body.set !== "object") return new Response("expected {key, set}", { status: 400 });
      if (!applyOverride(body.key, body.set)) return new Response("unknown key", { status: 400 });
      etagN++;
      console.log("PUT /api/overrides", JSON.stringify(body), "->", etag());
      return Response.json({ etag: etag() });
    }

    if (req.method === "POST" && url.pathname === "/dev/rotate-csrf") { csrf = `dev-${crypto.randomUUID().slice(0, 8)}`; return Response.json({ csrf }); }
    if (req.method === "POST" && url.pathname === "/dev/bump-etag") { etagN++; return Response.json({ etag: etag() }); }

    return new Response("not found", { status: 404 });
  },
});

console.log(`porthole dev server: http://${server.hostname}:${server.port}/  (viewer ${DEFAULT_VIEWER}; ?viewer=local, ?scenario=stale|scanning|warnings|none)`);

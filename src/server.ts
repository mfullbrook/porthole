// Listener A (remote, via tailscale serve only) and listener B (this Mac).
// Both bind 127.0.0.1. Host allowlist (421), no CORS, OPTIONS 405, owner gate
// on A, and Origin + CSRF + If-Match on the one write endpoint.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { Config } from "./config.ts";
import { MAX_BODY, parsePatch, type OverridesStore } from "./overrides.ts";
import type { Scanner } from "./scanner.ts";
import { viewSnapshot, type Viewer } from "./select.ts";
import type { StateStore } from "./state.ts";

export interface ServerDeps {
  cfg: Config;
  scanner: Scanner;
  overrides: OverridesStore;
  state: StateStore | null;
  webDir: string;
  csrf: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function respond(body: BodyInit | null, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "cache-control": "no-store", ...headers } });
}

const text = (status: number, msg: string, headers: Record<string, string> = {}) =>
  respond(msg + "\n", status, { "content-type": "text/plain; charset=utf-8", ...headers });

const json = (status: number, body: unknown) => respond(JSON.stringify(body), status, { "content-type": "application/json; charset=utf-8" });

export function makeHandler(listener: "A" | "B", deps: ServerDeps): (req: Request) => Promise<Response> {
  const viewer: Viewer = listener === "A" ? "remote" : "local";

  return async (req) => {
    const { cfg, scanner } = deps;
    const host = (req.headers.get("host") ?? "").toLowerCase();
    const url = new URL(req.url);
    let origin: string;

    if (listener === "A") {
      const fqdn = (scanner.snapshot?.fqdn ?? cfg.fqdn)?.toLowerCase();
      if (!fqdn) return text(503, "waiting for Tailscale");
      const app = `${fqdn}:${cfg.remotePort}`;
      if (host === fqdn || host === `${fqdn}:443`) {
        // ":443 /" → the porthole origin. Nothing else is served here: no data, no API.
        return respond(null, 302, { location: `https://${app}/` });
      }
      if (host !== app) return text(421, "misdirected request");
      const owner = cfg.owner ?? scanner.snapshot?.ownerLogin ?? null;
      if (!owner) return text(503, "waiting for Tailscale");
      const login = req.headers.get("tailscale-user-login");
      if (!login || login !== owner) return text(403, "forbidden: porthole is only for its owner");
      origin = `https://${app}`;
    } else {
      if (host !== `localhost:${cfg.localPort}` && host !== `127.0.0.1:${cfg.localPort}`) return text(421, "misdirected request");
      origin = `http://${host}`;
    }

    if (req.method === "OPTIONS") return text(405, "method not allowed", { allow: "GET, HEAD, PUT" });
    const path = url.pathname;

    if (path === "/api/overrides") {
      if (req.method !== "PUT") return text(405, "method not allowed", { allow: "PUT" });
      return putOverrides(req, origin, deps);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed", { allow: "GET, HEAD" });

    if (path === "/api/services") {
      scanner.touch();
      if (url.searchParams.get("fresh") === "1") await scanner.fresh(3000);
      return json(200, servicesBody(deps, viewer));
    }
    if (path === "/" || path === "/index.html") return indexHtml(deps);
    if (path === "/manifest.webmanifest") return staticFile(deps.webDir, "manifest.webmanifest");
    if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png") return staticFile(deps.webDir, "apple-touch-icon.png");
    if (path === "/favicon.ico") return staticFile(deps.webDir, "icon.svg");
    if (path.startsWith("/static/")) return staticFile(deps.webDir, path.slice("/static/".length));
    return text(404, "not found");
  };
}

export function servicesBody(deps: ServerDeps, viewer: Viewer) {
  const { scanner, overrides, state } = deps;
  const snap = scanner.snapshot;
  const ov = overrides.get();
  return {
    host: snap?.host ?? null,
    fqdn: snap?.fqdn ?? deps.cfg.fqdn,
    viewer,
    scannedAt: snap?.scannedAt ?? null,
    verifiedAt: snap?.verifiedAt ?? null,
    scanning: !snap,
    stale: scanner.isStale(),
    error: scanner.lastError,
    warnings: snap?.warnings ?? [],
    csrf: deps.csrf,
    overridesEtag: overrides.etag,
    services: snap
      ? viewSnapshot(snap, viewer, { overrides: ov, remembered: state?.all() ?? {}, ipv4: snap.tailscaleIPv4, fixes: scanner.fixes })
      : [],
  };
}

async function putOverrides(req: Request, origin: string, deps: ServerDeps): Promise<Response> {
  if (req.headers.get("origin") !== origin) return text(403, "forbidden: bad origin");
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(ct)) return text(415, "content-type must be application/json");
  const token = req.headers.get("x-porthole-csrf") ?? "";
  if (!timingSafeEqual(token, deps.csrf)) return text(403, "forbidden: bad csrf token");
  const ifMatch = req.headers.get("if-match");
  if (!ifMatch) return text(428, "If-Match required");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return text(413, "body too large");
  const raw = await req.text();
  if (raw.length > MAX_BODY) return text(413, "body too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return text(400, "body is not JSON");
  }
  const patch = parsePatch(body);
  if (typeof patch === "string") return text(400, patch);
  const etag = deps.overrides.update(ifMatch, patch);
  if (!etag) return json(409, { error: "changed elsewhere", etag: deps.overrides.etag });
  return json(200, { etag });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || !a) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function indexHtml(deps: ServerDeps): Response {
  const file = join(deps.webDir, "index.html");
  if (!existsSync(file)) return text(500, "web/index.html missing");
  const html = readFileSync(file, "utf8").replaceAll("__PORTHOLE_CSRF__", deps.csrf);
  return respond(html, 200, { "content-type": "text/html; charset=utf-8" });
}

function staticFile(webDir: string, name: string): Response {
  // Flat directory, plain names only: no traversal, no dotfiles, no server code.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.endsWith(".ts")) return text(404, "not found");
  const type = TYPES[extname(name)];
  if (!type || !readdirSync(webDir).includes(name)) return text(404, "not found");
  return respond(readFileSync(join(webDir, name)), 200, { "content-type": type, "cache-control": "no-cache" });
}

export function startServers(deps: ServerDeps): { stop: () => void; ports: { a: number | null; b: number } } {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const b = Bun.serve({ hostname: "127.0.0.1", port: deps.cfg.localPort, fetch: makeHandler("B", deps) });
  servers.push(b);
  let a: ReturnType<typeof Bun.serve> | null = null;
  if (deps.cfg.portA) {
    a = Bun.serve({ hostname: "127.0.0.1", port: deps.cfg.portA, fetch: makeHandler("A", deps) });
    servers.push(a);
  }
  return { stop: () => servers.forEach((s) => s.stop(true)), ports: { a: a?.port ?? null, b: b.port ?? deps.cfg.localPort } };
}

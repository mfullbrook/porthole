// Generated fix commands for blocked / not-responding / no-route rows, built from
// detected facts (bind address, port, framework, package manager). Never
// suggests bare --host or 0.0.0.0.

import type { ServiceDraft } from "./aggregate.ts";
import type { Fix, Route, TailscaleSelf } from "./types.ts";

function bound(svc: ServiceDraft, port: number): { addr: string; url: string } | null {
  const l = svc.listeners.find((x) => x.port === port) ?? svc.listeners[0];
  if (!l) return null;
  const b = l.binds.find((x) => x.kind === "loopback4") ?? l.binds.find((x) => x.kind === "loopback6");
  if (!b) return null;
  const host = b.addr.includes(":") ? `[${b.addr}]` : b.addr;
  return { addr: b.addr, url: `${host}:${l.port}` };
}

function bindAlternative(svc: ServiceDraft, ip4: string | undefined): string | null {
  if (!ip4) return null;
  const pm = svc.packageManager ?? "npm";
  const run = pm === "npm" ? "npm run dev --" : `${pm} dev`;
  if (svc.framework === "vite") return `Or bind Vite to the Tailscale IP: ${run} --host ${ip4} (never bare --host or 0.0.0.0, which exposes it on every LAN).`;
  if (svc.framework === "next") return `Or bind Next.js to the Tailscale IP: ${run} -H ${ip4} (never 0.0.0.0).`;
  return `Or bind the app to the Tailscale IP ${ip4} instead of loopback (never 0.0.0.0).`;
}

function allowedHosts(ts: TailscaleSelf, hosts: string[]): string {
  return `server: { allowedHosts: [${hosts.map((h) => JSON.stringify(h)).join(", ")}] }  // vite.config`;
}

function serveOff(servePort: number, https: boolean, path: string): string {
  const flag = https ? `--https=${servePort}` : `--http=${servePort}`;
  return path && path !== "/" ? `tailscale serve ${flag} --set-path=${path} off` : `tailscale serve ${flag} off`;
}

export function fixFor(svc: ServiceDraft, route: Route | null, ts: TailscaleSelf | null, usedServePorts: Set<number>): Fix | null {
  if (svc.hidden) return null; // no exposure fixes for hidden / denied services
  const ip4 = ts?.ips.find((ip) => !ip.includes(":"));
  const port = route?.port ?? svc.identityPort ?? 0;

  if (svc.deadServe) {
    const m = svc.deadServe;
    return {
      title: `Nothing listens on ${m.upstream!.host}:${m.upstream!.port}`,
      commands: [{ label: "Remove the mapping", cmd: serveOff(m.servePort, m.https, m.path) }],
      notes: ["Or start the app on that port again."],
    };
  }

  if (!route || route.state === "no_route") {
    const b = bound(svc, port);
    if (!b) return null;
    const upstream = svc.ports.find((p) => p.port === port)?.scheme === "https" ? `https+insecure://${b.url}` : `http://${b.url}`;
    const servePort = usedServePorts.has(port) || port === 443 ? 8000 + (port % 1000) : port;
    const notes: string[] = [];
    if (svc.framework === "vite" && ts) notes.push(`Vite also needs ${allowedHosts(ts, [ts.fqdn])}, or it answers "Blocked request".`);
    const alt = bindAlternative(svc, ip4);
    if (alt) notes.push(alt);
    return {
      title: `Bound to ${b.addr} only, not served`,
      commands: [
        { label: "Serve it on the tailnet", cmd: `tailscale serve --bg --https=${servePort} ${upstream}` },
        { label: "Undo", cmd: `tailscale serve --https=${servePort} off` },
      ],
      notes,
    };
  }

  if (route.state === "blocked") {
    if (route.preBlocked && ts) {
      const b = bound(svc, port);
      const m = /serve :(\d+)/.exec(route.label);
      const servePort = m ? Number(m[1]) : 443;
      return {
        title: route.preBlocked.reason,
        commands: b ? [{ label: "Point serve at the address the app uses", cmd: `tailscale serve --bg --https=${servePort} http://${b.url}` }] : [],
        notes: ["Or make the app listen on 127.0.0.1 too."],
      };
    }
    if (route.caveat === "host not allowed" && ts) {
      const host = new URL(route.url).hostname;
      return {
        title: `The dev server refuses the host "${host}"`,
        commands: [],
        notes: [svc.framework === "vite" || !svc.framework ? `Add it to ${allowedHosts(ts, [ts.hostName, ts.fqdn])}` : `Allow the host ${host} in the dev server's config.`],
      };
    }
    if (route.caveat?.startsWith("not the app")) {
      return {
        title: "This port is the Vite asset server, not the app",
        commands: [],
        notes: ["Open the Laravel app itself (its Herd site or artisan serve). Vite here only serves assets and hot reload."],
      };
    }
    if (route.caveat === "redirects to localhost") {
      return { title: "The app redirects to localhost", commands: [], notes: [`Set the app's public URL to ${route.url.replace(/\/$/, "")}.`] };
    }
  }

  if (route.state === "not_responding") {
    return { title: `Not answering at ${route.label}`, commands: [], notes: ["It may be starting up or hung. Retry, or restart it."] };
  }
  return null;
}

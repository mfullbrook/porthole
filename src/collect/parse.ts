// Pure parsers for collector output. Each takes the raw text a command printed
// and returns typed data, so the fixtures exercise exactly what the daemon runs.

import type {
  BindKind,
  Binding,
  DockerContainer,
  Family,
  Listener,
  ServeMapping,
  ServeUpstream,
  TailscaleSelf,
} from "../types.ts";

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcLPtn`. */
export function parseLsof(text: string): Binding[] {
  const out: Binding[] = [];
  let pid = 0;
  let command = "";
  let family: Family = "IPv4";
  for (const line of text.split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c") command = val;
    else if (tag === "f") family = "IPv4"; // reset per file; `t` follows
    else if (tag === "t") family = val === "IPv6" ? "IPv6" : "IPv4";
    else if (tag === "n") {
      const i = val.lastIndexOf(":");
      if (i < 0) continue;
      let addr = val.slice(0, i);
      const port = Number(val.slice(i + 1));
      if (!Number.isInteger(port)) continue;
      if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
      out.push({ pid, command, family, addr, port });
    }
  }
  return out;
}

export function bindKind(addr: string, family: Family, tailscaleIps: string[]): BindKind {
  if (addr === "127.0.0.1" || addr.startsWith("127.")) return "loopback4";
  if (addr === "::1") return "loopback6";
  if (addr === "*" || addr === "0.0.0.0" || addr === "::") {
    return family === "IPv6" ? "wildcard6" : "wildcard4";
  }
  if (tailscaleIps.includes(addr)) return addr.includes(":") ? "tailscale6" : "tailscale4";
  if (/^100\./.test(addr)) return "tailscale4";
  if (/^fd7a:/i.test(addr)) return "tailscale6";
  return "other";
}

/** Merge bindings of the same (pid, port) into one listener. */
export function toListeners(bindings: Binding[], tailscaleIps: string[]): Listener[] {
  const byKey = new Map<string, Listener>();
  for (const b of bindings) {
    const k = `${b.pid}:${b.port}`;
    let l = byKey.get(k);
    if (!l) {
      l = { pid: b.pid, port: b.port, command: b.command, binds: [] };
      byKey.set(k, l);
    }
    if (!l.binds.some((x) => x.addr === b.addr && x.family === b.family)) {
      l.binds.push({ addr: b.addr, family: b.family, kind: bindKind(b.addr, b.family, tailscaleIps) });
    }
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

export function formatBind(addr: string, family: Family, port: number): string {
  if (addr === "*") return `*:${port}${family === "IPv6" ? " (IPv6)" : ""}`;
  return addr.includes(":") ? `[${addr}]:${port}` : `${addr}:${port}`;
}

function parseUpstream(proxy: string): ServeUpstream | null {
  // "http://127.0.0.1:8765/rc", "https+insecure://localhost:8443", "3000", "localhost:3000"
  let s = proxy.trim();
  if (/^\d+$/.test(s)) s = `http://127.0.0.1:${s}`;
  if (!/^[a-z+]+:\/\//.test(s)) s = `http://${s}`;
  const m = s.match(/^(https\+insecure|https|http):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return null;
  const scheme = m[1] as ServeUpstream["scheme"];
  let host = m[2]!;
  if (host.startsWith("[")) host = host.slice(1, -1);
  const port = m[3] ? Number(m[3]) : scheme === "http" ? 80 : 443;
  const path = m[4] && m[4] !== "/" ? m[4].replace(/\/$/, "") : "";
  return { scheme, host, port, path };
}

/** Parse `tailscale serve status --json`. Funnel/TCP-forward-only entries are skipped. */
export function parseServeStatus(text: string): ServeMapping[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const j = JSON.parse(trimmed) as {
    TCP?: Record<string, { HTTP?: boolean; HTTPS?: boolean }>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  };
  const out: ServeMapping[] = [];
  for (const [hostPort, web] of Object.entries(j.Web ?? {})) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    const tcp = j.TCP?.[String(port)];
    const https = !tcp?.HTTP; // HTTPS unless the port is marked HTTP
    for (const [path, h] of Object.entries(web.Handlers ?? {})) {
      out.push({
        servePort: port,
        https,
        path,
        upstream: h.Proxy ? parseUpstream(h.Proxy) : null,
        raw: h.Proxy ?? h.Path ?? (h.Text !== undefined ? "text" : "?"),
      });
    }
  }
  return out.sort((a, b) => a.servePort - b.servePort || a.path.localeCompare(b.path));
}

/**
 * Parse `tailscale status --json` (full form), or the capture script's reduced
 * form (which carries `Owner` directly).
 */
export function parseTailscaleStatus(text: string): TailscaleSelf {
  const j = JSON.parse(text) as {
    MagicDNSSuffix?: string;
    Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; UserID?: number; Tags?: string[] | null };
    User?: Record<string, { LoginName?: string }>;
    Owner?: { LoginName?: string };
  };
  const self = j.Self ?? {};
  const fqdn = (self.DNSName ?? "").replace(/\.$/, "");
  const hostName = fqdn ? fqdn.split(".")[0]! : (self.HostName ?? "").toLowerCase();
  const tagged = Array.isArray(self.Tags) && self.Tags.length > 0;
  let login = j.Owner?.LoginName ?? (self.UserID !== undefined ? j.User?.[String(self.UserID)]?.LoginName : undefined) ?? null;
  // A tagged node's Self user is the tagged-devices pseudo-user: never an owner.
  if (tagged || login === "tagged-devices") login = null;
  return { hostName, fqdn, ips: self.TailscaleIPs ?? [], ownerLogin: login || null, tagged };
}

/** Parse `docker ps --format '{{json .}}'` (one object per line). */
export function parseDockerPs(text: string): DockerContainer[] {
  const out: DockerContainer[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const j = JSON.parse(line) as { Names?: string; Image?: string; Labels?: string; Ports?: string };
    const labels = new Map<string, string>();
    for (const kv of (j.Labels ?? "").split(",")) {
      const i = kv.indexOf("=");
      if (i > 0) labels.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const publications = [];
    // "127.0.0.1:6006->8080/tcp, [::]:80->80/tcp, 0.0.0.0:5432-5433->5432-5433/tcp"
    for (const part of (j.Ports ?? "").split(",")) {
      const m = part.trim().match(/^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/tcp$/);
      if (!m) continue;
      const first = Number(m[2]);
      const last = m[3] ? Number(m[3]) : first;
      for (let p = first; p <= last; p++) {
        publications.push({ hostIp: m[1]!.replace(/^\[|\]$/g, ""), hostPort: p, containerPort: Number(m[4]) + (p - first) });
      }
    }
    out.push({
      name: (j.Names ?? "").split(",")[0]!,
      image: j.Image ?? "",
      composeProject: labels.get("com.docker.compose.project") ?? null,
      publications,
    });
  }
  return out;
}

/** Parse `launchctl list` into pid -> label. */
export function parseLaunchctlList(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n").slice(1)) {
    const [pid, , label] = line.split("\t");
    if (pid && /^\d+$/.test(pid) && label) out.set(Number(pid), label);
  }
  return out;
}

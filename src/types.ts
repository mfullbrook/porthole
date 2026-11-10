// Shared data model. The snapshot is viewer-independent; route selection per
// viewer happens in select.ts.

export type Family = "IPv4" | "IPv6";

/** One lsof row: a socket listening on an address. */
export interface Binding {
  pid: number;
  command: string; // lsof's truncated command name
  family: Family;
  addr: string; // "127.0.0.1", "::1", "*", "100.101.102.103", "fd7a:…"
  port: number;
}

export type BindKind =
  | "loopback4"
  | "loopback6"
  | "wildcard4"
  | "wildcard6"
  | "tailscale4"
  | "tailscale6"
  | "other";

/** Bindings of one (pid, port), merged. */
export interface Listener {
  pid: number;
  port: number;
  command: string;
  binds: { addr: string; family: Family; kind: BindKind }[];
}

export interface GitInfo {
  toplevel: string;
  branch: string;
  commonDir: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  lstart: string; // process start time, part of the process-cache key
  command: string; // full argv
  cwd: string;
  git: GitInfo | null;
  /** From the lockfile next to cwd / the git toplevel, when the collector looked. */
  packageManager?: string | null;
}

export interface ServeUpstream {
  scheme: "http" | "https" | "https+insecure";
  host: string; // "127.0.0.1" | "::1" | "localhost" | other
  port: number;
  path: string; // "/rc" for path-preserving upstreams, "" otherwise
}

export interface ServeMapping {
  servePort: number;
  https: boolean; // false = plain HTTP serve port
  path: string; // mount path, "/" or "/rc"
  upstream: ServeUpstream | null; // null for non-proxy handlers (text, path)
  raw: string;
}

export interface TailscaleSelf {
  hostName: string; // short MagicDNS name, "mac-mini"
  fqdn: string; // "mac-mini.tail0a1b2c.ts.net" (no trailing dot)
  ips: string[];
  ownerLogin: string | null; // null when unknown or the node is tagged
  tagged: boolean;
}

export interface DockerPublication {
  hostIp: string;
  hostPort: number;
  containerPort: number;
}

export interface DockerContainer {
  name: string;
  image: string;
  composeProject: string | null;
  publications: DockerPublication[];
}

/** Everything one scan collects, before probing. Fixture-loadable. */
export interface Collected {
  bindings: Binding[];
  processes: Map<number, ProcessInfo>;
  /** Parent processes of listener pids (npm-run grouping). Optional. */
  parents: Map<number, ProcessInfo>;
  serve: ServeMapping[] | null; // null = collector failed
  tailscale: TailscaleSelf | null;
  docker: DockerContainer[] | null;
  launchd: Map<number, string> | null; // pid -> label
  warnings: Warning[];
}

export interface Warning {
  source: "lsof" | "tailscale" | "serve" | "docker" | "launchctl" | "git" | "ps";
  message: string;
}

/** Identity probe result for one listener. */
export interface ProbeResult {
  ok: boolean; // HTTP response with status < 500
  scheme: "http" | "https" | null;
  status: number | null;
  title: string | null;
  html: boolean;
  favicon: string | null;
  blockedSignature: string | null; // set when the probe body matched one
  error: string | null;
}

export type RouteState =
  | "verified"
  | "inferred"
  | "blocked"
  | "not_responding"
  | "no_route";

export type CandidateKind =
  | "serve_https"
  | "direct"
  | "serve_http"
  | "localhost";

export interface Candidate {
  url: string;
  label: string; // "serve :6006", "mac-mini:8844", "localhost:5173", "/rc"
  kind: CandidateKind;
  port: number; // listener port it reaches
  viewer: "remote" | "local";
  /** Decided before fetching (address-family mismatch). */
  preBlocked?: { reason: string };
  /** serve candidate: the upstream port, for the 502 rows. */
  upstreamPort?: number;
}

export interface Route extends Candidate {
  state: RouteState;
  caveat: string | null;
  checkedAt: number | null;
  /** True when the port is excluded from being the link (blocked/not the app/426). */
  excluded: boolean;
}

export interface Fix {
  title: string;
  commands: { label: string; cmd: string }[];
  notes: string[];
}

export type ServiceKind = "docker" | "launchd" | "git" | "serve" | "port";

export interface ServicePort {
  port: number;
  pid: number;
  process: string;
  binds: string[]; // "127.0.0.1:5173", "[::1]:5173", "*:3000 (IPv6)"
  title: string | null;
  scheme: "http" | "https" | null;
  probe: "ok" | "identifying" | "no_http" | "skipped";
  status: number | null;
}

export interface Service {
  key: string;
  kind: ServiceKind;
  name: string; // derived name (before rename)
  group: string;
  project: string | null;
  branch: string | null;
  worktree: string | null; // worktree dir name when not the main worktree
  container: string | null;
  launchdLabel: string | null;
  launcher: string | null;
  cwd: string | null;
  pid: number | null;
  command: string | null;
  identityPort: number | null;
  ports: ServicePort[];
  hidden: string | null; // rule name / reason when hidden by porthole
  identifying: boolean;
  routes: Route[]; // both viewers' candidates, verified
  /** For rows with no live listener (serve mapping to nothing). */
  deadServe?: ServeMapping;
  framework: string | null; // "vite" | "next" | …, for fixes
  packageManager: string | null;
}

export interface Snapshot {
  scannedAt: number;
  verifiedAt: number | null;
  host: string;
  fqdn: string | null;
  tailscaleIPv4: string | null;
  ownerLogin: string | null;
  services: Service[];
  warnings: Warning[];
  error: string | null;
}

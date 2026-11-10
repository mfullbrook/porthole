// Deny rules run before any network probe: nothing is ever sent to a listener
// one of these matches. The rule's reason is shown in the hidden list.

import type { DockerContainer, Listener, ProcessInfo } from "./types.ts";

export interface DenyContext {
  listener: Listener;
  proc: ProcessInfo | undefined;
  /** docker ps result; null when docker failed (OrbStack ports are then shown). */
  docker: DockerContainer[] | null;
  selfPid: number;
}

interface Rule {
  id: string;
  reason: string;
  match: (c: DenyContext) => boolean;
}

const cmdName = (c: DenyContext) => c.listener.command;
const fullCmd = (c: DenyContext) => c.proc?.command ?? c.listener.command;

export function isDockerProxy(l: Listener, proc?: ProcessInfo): boolean {
  return /^(OrbStack|com\.docke|vpnkit|docker-pr)/.test(l.command) || /OrbStack Helper|com\.docker\.backend/.test(proc?.command ?? "");
}

export function containerForPort(port: number, docker: DockerContainer[] | null): DockerContainer | null {
  return docker?.find((c) => c.publications.some((p) => p.hostPort === port)) ?? null;
}

const NON_HTTP_PORTS: Record<number, string> = {
  1025: "SMTP",
  22000: "Syncthing sync",
  5432: "Postgres",
  6379: "Redis",
  3306: "MySQL",
  27017: "MongoDB",
};

const RULES: Rule[] = [
  { id: "porthole", reason: "porthole itself", match: (c) => c.listener.pid === c.selfPid },
  {
    id: "system",
    reason: "macOS system service",
    match: (c) => /^(rapportd|ControlCe|sharingd|AirPlayXP|launchd|mDNSRespo|UserEvent)/.test(cmdName(c)),
  },
  {
    id: "non-http",
    reason: "not a web service",
    match: (c) =>
      /^(postgres|redis-ser|mysqld|mongod|memcached|meilisear)/.test(cmdName(c)) ||
      /\/(postgres|redis-server|mysqld|mongod|meilisearch)(\s|$)/.test(fullCmd(c)),
  },
  {
    id: "non-http-port",
    reason: "",
    match: (c) => c.listener.port in NON_HTTP_PORTS,
  },
  { id: "syncthing", reason: "Syncthing", match: (c) => /^syncthing/.test(cmdName(c)) },
  { id: "cli-helper", reason: "CLI helper (codex)", match: (c) => /^codex/.test(cmdName(c)) },
  {
    id: "ide",
    reason: "editor / IDE helper",
    match: (c) =>
      /^(GitKraken|Code\b|Code Helper|code-[0-9a-f]{6,}|remote-de|ijent|Cursor|jetbrains|idea|phpstorm|webstorm)/i.test(cmdName(c)) ||
      /\.vscode-server\/|\/remote-dev-server |(Visual Studio Code|Cursor|GitKraken|PhpStorm|IntelliJ IDEA|WebStorm|PyCharm|GoLand|RubyMine)[^/]*\.app\//.test(fullCmd(c)),
  },
  {
    id: "herd",
    reason: "Herd: local .test sites only",
    match: (c) => /^nginx/.test(cmdName(c)) && /\/Herd\//.test(c.proc?.cwd ?? "") || /Library\/Application Support\/Herd\//.test(fullCmd(c)),
  },
  {
    id: "python-worker",
    reason: "worker process (multiprocessing)",
    match: (c) => /multiprocessing\.spawn|multiprocessing\.forkserver/.test(fullCmd(c)),
  },
  {
    id: "orbstack-internal",
    reason: "OrbStack internal port",
    // Only once docker ps succeeded: when it failed, OrbStack ports are shown by number.
    match: (c) => c.docker !== null && isDockerProxy(c.listener, c.proc) && !containerForPort(c.listener.port, c.docker),
  },
];

/** Returns the hide reason, or null when the listener may be probed. */
export function denyReason(c: DenyContext): string | null {
  for (const r of RULES) {
    if (!r.match(c)) continue;
    if (r.id === "non-http-port") return `not a web service (${NON_HTTP_PORTS[c.listener.port]})`;
    return r.reason;
  }
  return null;
}

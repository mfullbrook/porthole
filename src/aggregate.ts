// Listener → service aggregation and service identity (design: "Listener →
// service aggregation", "Service identity"). Grouping happens only on positive
// evidence; the identity port never depends on route state or viewer.

import { basename, dirname, relative } from "node:path";
import { containerForPort, isDockerProxy } from "./deny.ts";
import { formatBind } from "./collect/parse.ts";
import type {
  DockerContainer,
  Listener,
  ProbeResult,
  ProcessInfo,
  Service,
  ServiceKind,
  ServicePort,
} from "./types.ts";

export type ProbeState = { state: ServicePort["probe"]; result: ProbeResult | null };

export interface AggregateInput {
  host: string;
  home: string;
  listeners: Listener[];
  processes: Map<number, ProcessInfo>;
  parents: Map<number, ProcessInfo>;
  docker: DockerContainer[] | null;
  launchd: Map<number, string> | null;
  /** keyed `${pid}:${port}` */
  probes: Map<string, ProbeState>;
  /** keyed `${pid}:${port}`; a reason when a deny rule matched */
  deny: Map<string, string>;
}

/** A service plus the listeners behind it (internal; stripped from the API). */
export interface ServiceDraft extends Service {
  listeners: Listener[];
}

const lk = (l: { pid: number; port: number }) => `${l.pid}:${l.port}`;

const IGNORED_GIT_TOPLEVELS = ["/opt/homebrew", "/usr/local/Homebrew", "/usr/local"];
const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|php[\d.]*|ruby[\d.]*|perl)$/;
const RUN_SCRIPT = /(?:^|\/)(npm|bun|pnpm|yarn)(?:\.c?js)?\s+(?:run(?:-script)?\s+)?([\w:.-]+)/;

export function tilde(path: string, home: string): string {
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}

export function usableGit(proc: ProcessInfo | undefined) {
  const g = proc?.git;
  if (!g || !g.toplevel) return null;
  if (IGNORED_GIT_TOPLEVELS.some((p) => g.toplevel === p || g.toplevel.startsWith(p + "/Homebrew"))) return null;
  // Main worktree: the parent of the common .git dir (a bare repo's common dir is the repo itself).
  const main = basename(g.commonDir) === ".git" ? dirname(g.commonDir) : g.commonDir || g.toplevel;
  return { ...g, main };
}

/** Basename of the script an interpreter runs, else the process name minus its version. */
export function launcherOf(proc: ProcessInfo | undefined, parent?: ProcessInfo): string | null {
  if (!proc) return null;
  const argv = proc.command.trim().split(/\s+/);
  const exe = basename(argv[0] ?? "");
  if (INTERPRETERS.test(exe)) {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "-m" && argv[i + 1]) return argv[i + 1]!;
      if (a === "-c" || a === "-e") break; // inline code: fall through to the parent script
      if (a.startsWith("-")) continue;
      if (a === "run" && /^bun$/.test(exe)) continue;
      return basename(a).replace(/\.(c|m)?(js|ts)$|\.py$/, "");
    }
  } else if (exe) {
    const name = exe.replace(/:$/, "").replace(/[-@]v?\d+(\.\d+)*$/, "");
    if (name) return name;
  }
  const m = parent?.command.match(RUN_SCRIPT);
  return m ? m[2]! : null;
}

export function frameworkOf(command: string): string | null {
  if (/\bvite(\.js)?\b/.test(command)) return "vite";
  if (/next-server|\bnext(\.js)?\s+(dev|start)|\/next\b/.test(command)) return "next";
  if (/storybook/.test(command)) return "storybook";
  if (/\bastro\b/.test(command)) return "astro";
  if (/\bnuxt\b/.test(command)) return "nuxt";
  if (/uvicorn/.test(command)) return "uvicorn";
  if (/artisan\s+serve/.test(command)) return "laravel";
  return null;
}

function prettyLabel(label: string): string {
  return label.replace(/^homebrew\.mxcl\./, "").replace(/^(com|org|io|dev)\.[^.]+\./, "");
}

function hasPage(p: ProbeState | undefined): boolean {
  const r = p?.result;
  if (!r?.ok) return false;
  return !!r.title && r.status !== 426 && r.status !== 404;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]!]!;
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export function aggregate(input: AggregateInput): ServiceDraft[] {
  const { listeners, processes, parents, docker, launchd, probes, deny } = input;
  const uf = new UnionFind(listeners.length);
  const proxy = listeners.map((l) => isDockerProxy(l, processes.get(l.pid)));

  const firstBy = new Map<string, number>();
  const join = (key: string, i: number) => {
    const j = firstBy.get(key);
    if (j === undefined) firstBy.set(key, i);
    else uf.union(i, j);
  };
  listeners.forEach((l, i) => {
    if (proxy[i]) {
      // Docker-published ports group by container, never by the proxy pid.
      const c = containerForPort(l.port, docker);
      if (c) join(`container:${c.name}`, i);
      return;
    }
    join(`pid:${l.pid}`, i);
    join(`port:${l.port}`, i); // worker pools (nginx) share a port across pids
  });

  // npm|bun|pnpm|yarn run siblings: a port with no page joins the sibling that has one.
  const byParent = new Map<string, number[]>();
  listeners.forEach((l, i) => {
    const proc = processes.get(l.pid);
    const parent = proc ? parents.get(proc.ppid) : undefined;
    if (!proc || !parent || !RUN_SCRIPT.test(parent.command)) return;
    const k = `${proc.ppid}|${proc.cwd}`;
    byParent.set(k, [...(byParent.get(k) ?? []), i]);
  });
  for (const idx of byParent.values()) {
    const withPage = idx.filter((i) => hasPage(probes.get(lk(listeners[i]!))));
    if (withPage.length === 0) continue;
    const anchor = withPage.sort((a, b) => listeners[a]!.port - listeners[b]!.port)[0]!;
    for (const i of idx) {
      if (!hasPage(probes.get(lk(listeners[i]!))) && listeners[i]!.pid !== listeners[anchor]!.pid) uf.union(i, anchor);
    }
  }

  const groups = new Map<number, Listener[]>();
  listeners.forEach((l, i) => {
    const r = uf.find(i);
    groups.set(r, [...(groups.get(r) ?? []), l]);
  });

  const services: ServiceDraft[] = [];
  for (const ls of groups.values()) services.push(buildService(input, ls.sort((a, b) => a.port - b.port || a.pid - b.pid)));
  return services.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

function buildService(input: AggregateInput, ls: Listener[]): ServiceDraft {
  const { host, home, processes, parents, docker, launchd, probes, deny } = input;
  const live = ls.filter((l) => !deny.has(lk(l)));
  const pool = live.length ? live : ls;
  // Identity port: lowest titled port, else lowest port (route state never enters).
  const identity = pool.find((l) => probes.get(lk(l))?.result?.title) ?? pool[0]!;
  const proc = processes.get(identity.pid);
  const parent = proc ? parents.get(proc.ppid) : undefined;
  const container = isDockerProxy(identity, proc) ? containerForPort(identity.port, docker) : null;
  let label = launchd?.get(identity.pid) ?? null;
  if (label?.startsWith("application.")) label = null; // per-launch GUI app labels aren't stable
  const git = container ? null : usableGit(proc);
  const launcher = launcherOf(proc, parent);
  const title = probes.get(lk(identity))?.result?.title ?? null;

  let kind: ServiceKind;
  let keyBody: string;
  if (container) {
    kind = "docker";
    keyBody = `docker:${container.name}`;
  } else if (label) {
    kind = "launchd";
    keyBody = `launchd:${label}`;
  } else if (git) {
    kind = "git";
    const wt = git.toplevel !== git.main ? `#${tilde(git.toplevel, home)}` : "";
    const rel = proc && proc.cwd !== git.toplevel && proc.cwd.startsWith(git.toplevel + "/") ? `@${relative(git.toplevel, proc.cwd)}` : "";
    keyBody = `git:${tilde(git.main, home)}${wt}:${launcher ?? identity.command}${rel}`;
  } else {
    kind = "port";
    keyBody = `port:${identity.port}`;
  }

  const name =
    title ?? container?.name ?? (label ? prettyLabel(label) : null) ?? launcher ?? `:${identity.port}`;
  const group = git ? basename(git.main) : container ? (container.composeProject ?? container.name) : label ? "Services" : "Other";

  const ports: ServicePort[] = ls.map((l) => {
    const p = probes.get(lk(l));
    return {
      port: l.port,
      pid: l.pid,
      process: l.command,
      binds: l.binds.map((b) => formatBind(b.addr, b.family, l.port)),
      title: p?.result?.title ?? null,
      scheme: p?.result?.scheme ?? null,
      probe: deny.has(lk(l)) ? "skipped" : (p?.state ?? "identifying"),
      status: p?.result?.status ?? null,
    };
  });

  const liveProbes = live.map((l) => probes.get(lk(l)));
  let hidden: string | null = null;
  if (!live.length) hidden = deny.get(lk(ls[0]!)) ?? "hidden";
  else if (liveProbes.every((p) => p?.state === "no_http")) hidden = "no HTTP response";
  else if (liveProbes.every((p) => p?.state === "no_http" || (p?.state === "ok" && !p.result?.html && !p.result?.title))) {
    hidden = "no page (API)";
  }
  const identifying = !!live.length && !liveProbes.some((p) => p?.state === "ok") && liveProbes.some((p) => !p || p.state === "identifying");

  return {
    key: `${host}/${keyBody}`,
    kind,
    name,
    group,
    project: git ? basename(git.main) : null,
    branch: git?.branch && git.branch !== "HEAD" ? git.branch : null,
    worktree: git && git.toplevel !== git.main ? basename(git.toplevel) : null,
    container: container?.name ?? null,
    launchdLabel: label,
    launcher,
    cwd: proc?.cwd ?? null,
    pid: identity.pid,
    command: proc?.command ?? identity.command,
    identityPort: identity.port,
    ports,
    hidden,
    identifying,
    routes: [],
    framework: frameworkOf(`${proc?.command ?? ""} ${parent?.command ?? ""}`),
    packageManager: proc?.packageManager ?? parent?.command.match(RUN_SCRIPT)?.[1] ?? null,
    listeners: ls,
  };
}

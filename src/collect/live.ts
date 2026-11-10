// Live macOS collectors. Each source fails on its own (a warning), except lsof,
// whose failure fails the scan. Process facts are cached per (pid, start time),
// git context per cwd until that worktree's HEAD changes.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Bins } from "../config.ts";
import { brief, exec } from "../exec.ts";
import type { Collected, GitInfo, ProcessInfo, Warning } from "../types.ts";
import { parseDockerPs, parseLaunchctlList, parseLsof, parseServeStatus, parseTailscaleStatus } from "./parse.ts";

interface PsRow {
  pid: number;
  lstart: string;
  ppid: number;
  command: string;
}

/** `ps -o pid=,lstart=,ppid=,command=`: lstart is a fixed 24-char field. */
export function parsePs(text: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\d+)\s(.*)$/);
    if (m) out.push({ pid: Number(m[1]), lstart: m[2]!, ppid: Number(m[3]), command: m[4]!.trimEnd() });
  }
  return out;
}

/** `lsof -a -p <pids> -d cwd -Fpn` → pid → cwd */
export function parseCwds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) out.set(pid, line.slice(1));
  }
  return out;
}

const LOCKFILES: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

function packageManager(dirs: string[]): string | null {
  for (const d of dirs) for (const [f, pm] of LOCKFILES) if (d && existsSync(join(d, f))) return pm;
  return null;
}

export class LiveCollector {
  private procs = new Map<string, ProcessInfo>(); // `${pid}|${lstart}`
  private git = new Map<string, { info: GitInfo | null; headPath: string | null; mtime: number }>();

  constructor(private bins: Bins) {}

  async collect(): Promise<Collected> {
    const b = this.bins;
    const warnings: Warning[] = [];
    const [lsof, ts, serve, docker, launchctl] = await Promise.all([
      exec([b.lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcLPtn"], { timeoutMs: 5000 }),
      exec([b.tailscale, "status", "--json"], { timeoutMs: 4000 }),
      exec([b.tailscale, "serve", "status", "--json"], { timeoutMs: 4000 }),
      exec([b.docker, "ps", "--format", "{{json .}}"], { timeoutMs: 3000 }),
      exec([b.launchctl, "list"], { timeoutMs: 3000 }),
    ]);
    // lsof exits 1 when some files can't be read but still prints listeners.
    if (!lsof.stdout.trim()) throw new Error(`lsof failed: ${brief(lsof)}`);
    const bindings = parseLsof(lsof.stdout);

    const tailscale = (() => {
      if (ts.code !== 0) {
        warnings.push({ source: "tailscale", message: `tailscale status failed: ${brief(ts)}` });
        return null;
      }
      try {
        return parseTailscaleStatus(ts.stdout);
      } catch (e) {
        warnings.push({ source: "tailscale", message: `tailscale status unreadable: ${(e as Error).message}` });
        return null;
      }
    })();
    if (tailscale?.tagged) warnings.push({ source: "tailscale", message: "this node is tagged: set an explicit owner in config.json" });

    let serveMappings = null;
    if (serve.code === 0) {
      try {
        serveMappings = parseServeStatus(serve.stdout);
      } catch (e) {
        warnings.push({ source: "serve", message: `serve status unreadable: ${(e as Error).message}` });
      }
    } else warnings.push({ source: "serve", message: `tailscale serve status failed: ${brief(serve)}` });

    let containers = null;
    if (docker.code === 0) {
      try {
        containers = parseDockerPs(docker.stdout);
      } catch (e) {
        warnings.push({ source: "docker", message: `docker ps unreadable: ${(e as Error).message}` });
      }
    } else warnings.push({ source: "docker", message: "docker unavailable: containers shown by port only" });

    let launchd = null;
    if (launchctl.code === 0) launchd = parseLaunchctlList(launchctl.stdout);
    else warnings.push({ source: "launchctl", message: `launchctl list failed: ${brief(launchctl)}` });

    const pids = [...new Set(bindings.map((x) => x.pid))];
    const processes = await this.processes(pids, warnings);
    const ppids = [...new Set([...processes.values()].map((p) => p.ppid).filter((p) => p > 1))];
    const parents = await this.processes(ppids, warnings, false);

    return { bindings, processes, parents, serve: serveMappings, tailscale, docker: containers, launchd, warnings };
  }

  /** One ps call for all pids; cwd + git only for (pid, start) pairs not seen before. */
  private async processes(pids: number[], warnings: Warning[], withGit = true): Promise<Map<number, ProcessInfo>> {
    const out = new Map<number, ProcessInfo>();
    if (!pids.length) return out;
    const ps = await exec([this.bins.ps, "-o", "pid=,lstart=,ppid=,command=", "-p", pids.join(",")], { timeoutMs: 3000 });
    const rows = parsePs(ps.stdout);
    if (!rows.length && ps.code !== 0) warnings.push({ source: "ps", message: `ps failed: ${brief(ps)}` });
    const fresh = rows.filter((r) => !this.procs.has(`${r.pid}|${r.lstart}`));
    let cwds = new Map<number, string>();
    if (fresh.length) {
      const r = await exec([this.bins.lsof, "-a", "-p", fresh.map((x) => x.pid).join(","), "-d", "cwd", "-Fpn"], { timeoutMs: 3000 });
      cwds = parseCwds(r.stdout);
    }
    const live = new Set<string>();
    for (const r of rows) {
      const k = `${r.pid}|${r.lstart}`;
      live.add(k);
      let p = this.procs.get(k);
      if (!p) {
        p = { pid: r.pid, ppid: r.ppid, lstart: r.lstart, command: r.command, cwd: cwds.get(r.pid) ?? "", git: null, packageManager: null };
        this.procs.set(k, p);
      }
      if (withGit && p.cwd && p.cwd !== "/") {
        p.git = await this.gitFor(p.cwd, warnings);
        p.packageManager = packageManager([p.cwd, p.git?.toplevel ?? ""]);
      }
      out.set(r.pid, p);
    }
    if (withGit) for (const k of this.procs.keys()) if (!live.has(k) && pids.includes(Number(k.split("|")[0]))) this.procs.delete(k);
    return out;
  }

  private async gitFor(cwd: string, warnings: Warning[]): Promise<GitInfo | null> {
    const cached = this.git.get(cwd);
    if (cached) {
      const mtime = cached.headPath ? mtimeOf(cached.headPath) : 0;
      if (mtime === cached.mtime) return cached.info;
    }
    const r = await exec(
      [this.bins.git, "-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
      { timeoutMs: 2000 },
    );
    let info: GitInfo | null = null;
    let headPath: string | null = null;
    if (r.code === 0) {
      const [toplevel, gitDir, commonDir, branch] = r.stdout.trim().split("\n");
      if (toplevel && gitDir && commonDir) {
        info = { toplevel, branch: branch ?? "", commonDir };
        headPath = join(gitDir, "HEAD");
      }
    } else if (!/not a git repository/i.test(r.stderr)) {
      warnings.push({ source: "git", message: `git failed in ${cwd}: ${brief(r)}` });
    }
    this.git.set(cwd, { info, headPath, mtime: headPath ? mtimeOf(headPath) : 0 });
    return info;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

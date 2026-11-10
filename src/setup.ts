// porthole setup / teardown / status. Both are idempotent. The serve backup is
// taken only if none exists and ":443 /" isn't already porthole, and teardown
// renames it after restoring, so a later setup takes a fresh one.

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLsof, parseServeStatus } from "./collect/parse.ts";
import { loadConfig, missingBins, paths, saveConfig, writeFileAtomic, type Config } from "./config.ts";
import { brief, exec, type ExecResult } from "./exec.ts";
import type { ServeMapping } from "./types.ts";

export const LABEL = "dev.porthole.daemon";
export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logPath = () => join(homedir(), "Library", "Logs", "porthole.log");

/** Everything setup/teardown touch outside porthole's config dir. Faked in tests. */
export interface Sys {
  tailscale(args: string[]): Promise<ExecResult>;
  listeners(): Promise<{ port: number; pid: number; command: string }[]>;
  installAgent(plist: string): Promise<void>;
  removeAgent(): Promise<void>;
  waitForDaemon(localPort: number): Promise<boolean>;
  freePort(): Promise<number>;
  log(msg: string): void;
}

export function realSys(cfg: Config): Sys {
  const uid = process.getuid?.() ?? 501;
  return {
    tailscale: (args) => exec([cfg.bins.tailscale, ...args], { timeoutMs: 15000 }),
    async listeners() {
      const r = await exec([cfg.bins.lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcLPtn"]);
      const bindings = parseLsof(r.stdout);
      const pids = [...new Set(bindings.map((b) => b.pid))];
      const ps = pids.length ? await exec([cfg.bins.ps, "-o", "pid=,command=", "-p", pids.join(",")]) : { stdout: "" };
      const cmds = new Map(ps.stdout.split("\n").map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map((m) => [Number(m![1]), m![2]!]));
      return bindings.map((b) => ({ port: b.port, pid: b.pid, command: cmds.get(b.pid) ?? b.command }));
    },
    async installAgent(plist) {
      await exec([cfg.bins.launchctl, "bootout", `gui/${uid}/${LABEL}`]);
      writeFileAtomic(plistPath(), plist);
      const r = await exec([cfg.bins.launchctl, "bootstrap", `gui/${uid}`, plistPath()]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${brief(r)}`);
    },
    async removeAgent() {
      await exec([cfg.bins.launchctl, "bootout", `gui/${uid}/${LABEL}`]);
      rmSync(plistPath(), { force: true });
    },
    async waitForDaemon(localPort) {
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${localPort}/api/services`, { headers: { host: `localhost:${localPort}` }, signal: AbortSignal.timeout(1000) });
          if (r.ok) return true;
        } catch {
          // not up yet
        }
        await Bun.sleep(250);
      }
      return false;
    },
    async freePort() {
      const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = s.port;
      s.stop(true);
      return port;
    },
    log: (m) => console.log(m),
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(bun: string, root: string): string {
  const args = [bun, join(root, "src", "cli.ts"), "run"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath())}</string>
</dict>
</plist>
`;
}

const isOurs = (command: string, root: string) => command.includes(join(root, "src", "cli.ts"));

function rootHandler(serve: ServeMapping[]): ServeMapping | undefined {
  return serve.find((m) => m.servePort === 443 && m.path === "/");
}

const pointsAt = (m: ServeMapping | undefined, port: number) =>
  !!m?.upstream && ["127.0.0.1", "localhost"].includes(m.upstream.host) && m.upstream.port === port && !m.upstream.path;

async function serveStatus(sys: Sys): Promise<{ raw: string; mappings: ServeMapping[] }> {
  const r = await sys.tailscale(["serve", "status", "--json"]);
  if (r.code !== 0) throw new Error(`tailscale serve status failed: ${brief(r)}`);
  return { raw: r.stdout, mappings: parseServeStatus(r.stdout) };
}

/** Handlers other than the ones setup is allowed to touch, for the before/after check. */
function untouched(m: ServeMapping[], remotePort: number): string[] {
  return m.filter((x) => x.servePort !== remotePort && !(x.servePort === 443 && x.path === "/")).map((x) => `${x.servePort}${x.path} ${x.https ? "https" : "http"} ${x.raw}`);
}

export interface SetupOptions {
  root: string;
  bun: string;
  keepRoot: boolean;
  dryRun: boolean;
}

export async function runSetup(sys: Sys, cfg: Config, o: SetupOptions): Promise<number> {
  const required = missingBins(cfg.bins).filter((b) => !b.startsWith("docker"));
  if (required.length) {
    sys.log(`✕ missing: ${required.join(", ")}. Fix the paths in ${paths.config()}.`);
    return 1;
  }
  const st = await sys.tailscale(["status", "--json"]);
  let fqdn = "";
  let tagged = false;
  try {
    const j = JSON.parse(st.stdout);
    fqdn = String(j.Self?.DNSName ?? "").replace(/\.$/, "");
    tagged = Array.isArray(j.Self?.Tags) && j.Self.Tags.length > 0;
  } catch {
    // handled below
  }
  if (!fqdn) {
    sys.log("✕ Tailscale isn't running, or MagicDNS is off: no FQDN for this machine.");
    return 1;
  }
  if (tagged && !cfg.owner) sys.log(`! this node is tagged: set "owner" (your Tailscale login) in ${paths.config()}, or listener A answers 503.`);

  const before = await serveStatus(sys);
  const listeners = await sys.listeners();
  const holder = (port: number) => listeners.find((l) => l.port === port);

  // The dedicated origin port: free in serve (or already ours) and not a local listener.
  const remote = before.mappings.filter((m) => m.servePort === cfg.remotePort);
  if (remote.length && !remote.every((m) => cfg.portA && pointsAt(m, cfg.portA))) {
    sys.log(`✕ tailscale serve already uses :${cfg.remotePort} (${remote.map((m) => m.raw).join(", ")}). Set "remotePort" in ${paths.config()}.`);
    return 1;
  }
  const remoteHolder = holder(cfg.remotePort);
  if (remoteHolder && !isOurs(remoteHolder.command, o.root)) {
    sys.log(`✕ :${cfg.remotePort} is in use by pid ${remoteHolder.pid} (${remoteHolder.command}).`);
    return 1;
  }
  const localHolder = holder(cfg.localPort);
  if (localHolder && !isOurs(localHolder.command, o.root)) {
    sys.log(`✕ :${cfg.localPort} (the Mac mini's entry point) is in use by pid ${localHolder.pid} (${localHolder.command}). Set "localPort" in ${paths.config()}.`);
    return 1;
  }
  // Listener A's loopback port is picked once and kept; only serve connects to it.
  const aHolder = cfg.portA ? holder(cfg.portA) : undefined;
  const portA = cfg.portA && (!aHolder || isOurs(aHolder.command, o.root)) ? cfg.portA : await sys.freePort();

  const next: Config = { ...cfg, portA, fqdn };
  const target = `http://127.0.0.1:${portA}`;
  const steps: string[] = [
    `write ${paths.config()} (listener A on 127.0.0.1:${portA})`,
    `install LaunchAgent ${plistPath()}`,
  ];
  const root = rootHandler(before.mappings);
  const backupNeeded = !existsSync(paths.serveBackup()) && !pointsAt(root, portA);
  if (backupNeeded) steps.push(`back up serve config to ${paths.serveBackup()}`);
  const cmds: string[][] = [["serve", "--bg", `--https=${cfg.remotePort}`, target]];
  if (!o.keepRoot) cmds.push(["serve", "--bg", "--https=443", "--set-path=/", target]);
  steps.push(...cmds.map((c) => `tailscale ${c.join(" ")}`));

  if (o.dryRun) {
    sys.log("Dry run. setup would:");
    for (const s of steps) sys.log(`  - ${s}`);
    return 0;
  }

  saveConfig(next);
  await sys.installAgent(plist(o.bun, o.root));
  if (!(await sys.waitForDaemon(cfg.localPort))) {
    sys.log(`✕ the daemon didn't answer on http://localhost:${cfg.localPort}/. See ${logPath()}. Serve config left unchanged.`);
    return 1;
  }
  if (backupNeeded) writeFileAtomic(paths.serveBackup(), before.raw.trim() + "\n");
  for (const c of cmds) {
    const r = await sys.tailscale(c);
    if (r.code !== 0) {
      sys.log(`✕ tailscale ${c.join(" ")} failed: ${brief(r)}`);
      return 1;
    }
  }
  const after = await serveStatus(sys);
  const lost = untouched(before.mappings, cfg.remotePort).filter((h) => !untouched(after.mappings, cfg.remotePort).includes(h));
  if (lost.length) {
    sys.log(`✕ other serve handlers changed unexpectedly: ${lost.join("; ")}. Backup: ${paths.serveBackup()}`);
    return 1;
  }
  sys.log(`✓ porthole is running.
  Remote devices: https://${fqdn}/  (save it to the Home Screen; it redirects to https://${fqdn}:${cfg.remotePort}/)
  This Mac:       http://localhost:${cfg.localPort}/`);
  if (o.keepRoot) sys.log(`  ":443 /" left as it was (--keep-root). Porthole is at https://${fqdn}:${cfg.remotePort}/.`);
  else if (root && !pointsAt(root, portA)) sys.log(`  ":443 /" moved from ${root.raw} to porthole. \`porthole teardown\` puts it back.`);
  return 0;
}

export async function runTeardown(sys: Sys, cfg: Config, o: { dryRun: boolean }): Promise<number> {
  const steps: string[] = [`remove LaunchAgent ${plistPath()}`];
  const cmds: string[][] = [];
  const now = await serveStatus(sys);
  if (now.mappings.some((m) => m.servePort === cfg.remotePort && cfg.portA && pointsAt(m, cfg.portA))) {
    cmds.push(["serve", `--https=${cfg.remotePort}`, "off"]);
  }
  const current = rootHandler(now.mappings);
  const ours = cfg.portA ? pointsAt(current, cfg.portA) : false;
  let note = "";
  let rename = false;
  if (existsSync(paths.serveBackup())) {
    rename = true;
    const backed = rootHandler(parseServeStatus(readFileSync(paths.serveBackup(), "utf8")));
    if (!ours) {
      note = `":443 /" no longer points at porthole (${current?.raw ?? "none"}); left alone.`;
    } else if (backed?.upstream) {
      const alive = (await sys.listeners()).some((l) => l.port === backed.upstream!.port);
      if (alive) {
        cmds.push(["serve", "--bg", "--https=443", "--set-path=/", backed.raw]);
        note = `":443 /" restored to ${backed.raw}.`;
      } else {
        cmds.push(["serve", "--https=443", "--set-path=/", "off"]);
        note = `":443 /" removed: the backed-up target ${backed.raw} isn't listening any more.`;
      }
    } else {
      cmds.push(["serve", "--https=443", "--set-path=/", "off"]);
      note = `":443 /" removed (there was no "/" handler before setup).`;
    }
  } else {
    note = `no serve backup, so ":443 /" was left alone${ours ? " (it still points at porthole's port)" : ""}.`;
  }
  steps.push(...cmds.map((c) => `tailscale ${c.join(" ")}`));
  if (rename) steps.push(`rename ${paths.serveBackup()} to serve-backup.<timestamp>.json`);

  if (o.dryRun) {
    sys.log("Dry run. teardown would:");
    for (const s of steps) sys.log(`  - ${s}`);
    sys.log(`  (${note})`);
    return 0;
  }
  await sys.removeAgent();
  for (const c of cmds) {
    const r = await sys.tailscale(c);
    if (r.code !== 0) {
      sys.log(`✕ tailscale ${c.join(" ")} failed: ${brief(r)}`);
      return 1;
    }
  }
  if (rename) renameSync(paths.serveBackup(), paths.serveBackup().replace(/\.json$/, `.${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  sys.log(`✓ porthole removed. ${note}
  Kept: ${paths.config()}, ${paths.overrides()}, ${paths.state()}.`);
  return 0;
}

export async function setup(args: string[], root: string): Promise<number> {
  const cfg = loadConfig();
  return runSetup(realSys(cfg), cfg, { root, bun: process.execPath, keepRoot: args.includes("--keep-root"), dryRun: args.includes("--dry-run") });
}

export async function teardown(args: string[]): Promise<number> {
  const cfg = loadConfig();
  return runTeardown(realSys(cfg), cfg, { dryRun: args.includes("--dry-run") });
}

export async function status(): Promise<number> {
  const cfg = loadConfig();
  const sys = realSys(cfg);
  console.log(`config     ${paths.config()}${existsSync(paths.config()) ? "" : " (not set up)"}`);
  console.log(`listener A 127.0.0.1:${cfg.portA || "-"} → serve https :${cfg.remotePort}${cfg.fqdn ? ` (https://${cfg.fqdn}:${cfg.remotePort}/)` : ""}`);
  console.log(`listener B http://localhost:${cfg.localPort}/`);
  console.log(`agent      ${existsSync(plistPath()) ? plistPath() : "not installed"}`);
  console.log(`backup     ${existsSync(paths.serveBackup()) ? paths.serveBackup() : "none"}`);
  try {
    const s = await serveStatus(sys);
    for (const m of s.mappings) console.log(`serve      :${m.servePort}${m.path} → ${m.raw}${cfg.portA && pointsAt(m, cfg.portA) ? "  (porthole)" : ""}`);
  } catch (e) {
    console.log(`serve      ${(e as Error).message}`);
  }
  const up = await sys.waitForDaemon(cfg.localPort).catch(() => false);
  console.log(`daemon     ${up ? "answering" : "not answering"}`);
  return 0;
}

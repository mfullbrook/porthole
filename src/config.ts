// ~/.config/porthole/config.json: ports and absolute binary paths, written by
// `porthole setup`. launchd's PATH lacks tailscale, docker and bun, so every
// external command runs by absolute path.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Bins {
  lsof: string;
  ps: string;
  git: string;
  launchctl: string;
  tailscale: string;
  docker: string;
}

export interface Config {
  /** serve HTTPS port of porthole's dedicated origin (https://<fqdn>:7443). */
  remotePort: number;
  /** listener A's loopback port; only serve connects to it. 0 = not set up (A disabled). */
  portA: number;
  /** listener B: the Mac mini's own entry point, http://localhost:<localPort>/. */
  localPort: number;
  /** Explicit owner login; overrides the Self user from tailscale status. */
  owner: string | null;
  /** FQDN saved at setup, used for the Host allowlist until a scan reports it. */
  fqdn: string | null;
  bins: Bins;
}

export const DEFAULT_BINS: Bins = {
  lsof: "/usr/sbin/lsof",
  ps: "/bin/ps",
  git: "/usr/bin/git",
  launchctl: "/bin/launchctl",
  tailscale: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  docker: "/usr/local/bin/docker",
};

export const DEFAULT_CONFIG: Config = {
  remotePort: 7443,
  portA: 0,
  localPort: 7444,
  owner: null,
  fqdn: null,
  bins: DEFAULT_BINS,
};

export function configDir(): string {
  return process.env.PORTHOLE_CONFIG_DIR ?? join(homedir(), ".config", "porthole");
}

export const paths = {
  config: () => join(configDir(), "config.json"),
  overrides: () => join(configDir(), "overrides.json"),
  state: () => join(configDir(), "state.json"),
  serveBackup: () => join(configDir(), "serve-backup.json"),
};

export function loadConfig(): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(paths.config(), "utf8")) as Partial<Config>;
  } catch {
    // missing or unreadable: defaults (listener A stays off until setup)
  }
  const cfg: Config = { ...DEFAULT_CONFIG, ...file, bins: { ...DEFAULT_BINS, ...(file.bins ?? {}) } };
  // Dev overrides
  if (process.env.PORTHOLE_PORT_A) cfg.portA = Number(process.env.PORTHOLE_PORT_A);
  if (process.env.PORTHOLE_LOCAL_PORT) cfg.localPort = Number(process.env.PORTHOLE_LOCAL_PORT);
  return cfg;
}

/** Atomic write (temp file + rename), user-only permissions. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveConfig(cfg: Config): void {
  writeFileAtomic(paths.config(), JSON.stringify(cfg, null, 2) + "\n");
}

export function missingBins(bins: Bins): string[] {
  return Object.entries(bins)
    .filter(([, p]) => !existsSync(p))
    .map(([k, p]) => `${k} (${p})`);
}

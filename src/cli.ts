#!/usr/bin/env bun
// porthole: run | scan | setup | teardown | status

import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { LiveCollector } from "./collect/live.ts";
import { loadConfig, missingBins, paths } from "./config.ts";
import { bunHttp } from "./http.ts";
import { OverridesStore } from "./overrides.ts";
import { Scanner } from "./scanner.ts";
import { startServers } from "./server.ts";
import { viewSnapshot } from "./select.ts";
import { StateStore } from "./state.ts";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "web");

function makeScanner(opts: { persist: boolean }) {
  const cfg = loadConfig();
  const overrides = new OverridesStore(paths.overrides());
  const state = opts.persist ? new StateStore(paths.state()) : null;
  const scanner = new Scanner({
    collect: (() => {
      const c = new LiveCollector(cfg.bins);
      return () => c.collect();
    })(),
    http: bunHttp,
    overrides: () => overrides.get(),
    state,
    opts: {
      host: hostname().split(".")[0]!.toLowerCase(),
      home: homedir(),
      selfPid: process.pid,
      selfPorts: new Set([cfg.portA, cfg.localPort].filter(Boolean)),
    },
    log: (m) => console.log(`${new Date().toISOString()} ${m}`),
  });
  return { cfg, overrides, state, scanner };
}

async function run() {
  const { cfg, overrides, state, scanner } = makeScanner({ persist: true });
  const missing = missingBins(cfg.bins);
  if (missing.length) console.warn(`porthole: missing binaries (those sources will warn): ${missing.join(", ")}`);
  const csrf = randomBytes(24).toString("base64url");
  let servers;
  try {
    servers = startServers({ cfg, scanner, overrides, state, webDir: WEB, csrf });
  } catch (e) {
    // Port taken: exit with a clear log; `porthole setup` picks a new listener A port.
    console.error(`porthole: could not listen (${(e as Error).message}). Is another porthole running? Re-run \`porthole setup\` to pick new ports.`);
    process.exit(1);
  }
  console.log(`porthole: listener B http://localhost:${servers.ports.b}/` + (servers.ports.a ? `, listener A 127.0.0.1:${servers.ports.a} (serve :${cfg.remotePort})` : ", listener A off (run `porthole setup`)"));
  scanner.start();
  const shutdown = () => {
    scanner.stop();
    servers.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function scanOnce(args: string[]) {
  const { scanner, overrides } = makeScanner({ persist: false });
  await scanner.scanNow();
  // Second pass picks up probes that missed the first scan's budget.
  await scanner.scanNow();
  const snap = scanner.snapshot;
  if (!snap) {
    console.error(`scan failed: ${scanner.lastError}`);
    process.exit(1);
  }
  const viewer = args.includes("--local") ? "local" : "remote";
  const views = viewSnapshot(snap, viewer, { overrides: overrides.get(), remembered: {}, ipv4: snap.tailscaleIPv4, fixes: scanner.fixes });
  if (args.includes("--json")) {
    console.log(JSON.stringify(views, null, 2));
    return;
  }
  const all = args.includes("--all");
  for (const v of views.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))) {
    if (v.hidden && !all) continue;
    const sym = v.state === "verified" ? "✓" : v.state === "inferred" ? "≈" : "✕";
    const where = v.url ?? v.reason ?? "";
    console.log(`${v.hidden ? "  (hidden)" : ""}${sym} ${v.group} / ${v.name}${v.branch ? ` [${v.branch}]` : ""}  ${where}${v.caveat ? ` · ${v.caveat}` : ""}${v.hidden ? `  — ${v.hidden}` : ""}`);
  }
  for (const w of snap.warnings) console.log(`! ${w.source}: ${w.message}`);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "run":
    await run();
    break;
  case "scan":
    await scanOnce(args);
    process.exit(0);
  case "setup": {
    const { setup } = await import("./setup.ts");
    process.exit(await setup(args, ROOT));
  }
  case "teardown": {
    const { teardown } = await import("./setup.ts");
    process.exit(await teardown(args));
  }
  case "status": {
    const { status } = await import("./setup.ts");
    process.exit(await status());
  }
  default:
    console.log(`usage: porthole <command>

  run        run the daemon (the LaunchAgent runs this)
  scan       one scan, printed as a table [--local] [--all] [--json]
  setup      install the LaunchAgent and tailscale serve mappings [--keep-root] [--dry-run]
  teardown   remove them and restore the backed-up "/" handler [--dry-run]
  status     show config, LaunchAgent and serve state`);
    process.exit(cmd ? 2 : 0);
}

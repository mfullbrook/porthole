// state.json: last known name / group / URL / time per service key, so pinned
// tiles can say "not running · last seen 14:02" after a daemon restart.

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./config.ts";
import type { Remembered } from "./select.ts";

export class StateStore {
  private data: Record<string, Remembered> = {};
  private dirty = false;
  private lastWrite = 0;

  constructor(private path: string) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      if (j && typeof j === "object" && j.services && typeof j.services === "object") this.data = j.services;
    } catch {
      // first run
    }
  }

  all(): Record<string, Remembered> {
    return this.data;
  }

  see(key: string, name: string, group: string, url: string | null, now: number): void {
    const prev = this.data[key];
    if (!prev || prev.name !== name || prev.group !== group || prev.url !== url) this.dirty = true;
    // lastSeen alone changes every scan: persist it at most every 5 minutes.
    if (prev && now - this.lastWrite > 300_000) this.dirty = true;
    this.data[key] = { name, group, url, lastSeen: now };
  }

  flush(now: number): void {
    if (!this.dirty) return;
    try {
      writeFileAtomic(this.path, JSON.stringify({ version: 1, services: this.data }) + "\n");
      this.dirty = false;
      this.lastWrite = now;
    } catch (e) {
      console.error(`porthole: could not write ${this.path}: ${(e as Error).message}`);
    }
  }
}

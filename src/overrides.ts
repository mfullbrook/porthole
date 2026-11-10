// overrides.json: pin / rename / hide per service key. The only file the
// browser can change. Strict validation, atomic writes, etag for If-Match.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./config.ts";
import type { Overrides, ServiceOverride } from "./select.ts";

export const MAX_BODY = 64 * 1024;
const MAX_KEY = 400;
const MAX_NAME = 120;
const MAX_ENTRIES = 2000;

export function emptyOverrides(): Overrides {
  return { version: 1, services: {} };
}

export function etagOf(text: string): string {
  return `"${createHash("sha256").update(text).digest("hex").slice(0, 16)}"`;
}

function isKey(k: unknown): k is string {
  return typeof k === "string" && k.length > 0 && k.length <= MAX_KEY && !/[\u0000-\u001f]/.test(k);
}

function validEntry(v: unknown): v is ServiceOverride {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const [f, x] of Object.entries(v)) {
    if (f === "pin" || f === "hide") {
      if (typeof x !== "boolean") return false;
    } else if (f === "rename") {
      if (typeof x !== "string" || x.length > MAX_NAME) return false;
    } else return false;
  }
  return true;
}

export function validateOverrides(doc: unknown): doc is Overrides {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as Record<string, unknown>;
  if (d.version !== 1 || !d.services || typeof d.services !== "object" || Array.isArray(d.services)) return false;
  const entries = Object.entries(d.services as Record<string, unknown>);
  return entries.length <= MAX_ENTRIES && entries.every(([k, v]) => isKey(k) && validEntry(v));
}

export interface Patch {
  key: string;
  set: { pin?: boolean | null; rename?: string | null; hide?: boolean | null };
}

export function parsePatch(body: unknown): Patch | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== "key" && k !== "set");
  if (extra.length) return `unknown field ${extra[0]}`;
  if (!isKey(b.key)) return "key must be a non-empty string";
  if (!b.set || typeof b.set !== "object" || Array.isArray(b.set)) return "set must be an object";
  const set = b.set as Record<string, unknown>;
  for (const [f, v] of Object.entries(set)) {
    if (f === "pin" || f === "hide") {
      if (v !== null && typeof v !== "boolean") return `${f} must be boolean or null`;
    } else if (f === "rename") {
      if (v !== null && (typeof v !== "string" || v.length > MAX_NAME)) return `rename must be a string of at most ${MAX_NAME} chars, or null`;
    } else return `unknown field set.${f}`;
  }
  return { key: b.key, set: set as Patch["set"] };
}

export function applyPatch(doc: Overrides, p: Patch): Overrides {
  const services = { ...doc.services };
  const entry: ServiceOverride = { ...(services[p.key] ?? {}) };
  for (const f of ["pin", "rename", "hide"] as const) {
    if (!(f in p.set)) continue;
    const v = p.set[f];
    if (v === null || v === undefined || (f === "rename" && typeof v === "string" && !v.trim())) delete entry[f];
    else (entry as Record<string, unknown>)[f] = f === "rename" ? (v as string).trim() : v;
  }
  if (Object.keys(entry).length) services[p.key] = entry;
  else delete services[p.key];
  return { version: 1, services };
}

/** File-backed store; re-reads when the file changes on disk (hand edits). */
export class OverridesStore {
  private doc: Overrides = emptyOverrides();
  private text = "";
  etag = etagOf("");

  constructor(private path: string) {
    this.reload();
  }

  reload(): void {
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      text = "";
    }
    if (text === this.text) return;
    if (!text) {
      this.doc = emptyOverrides();
    } else {
      try {
        const doc = JSON.parse(text);
        if (validateOverrides(doc)) this.doc = doc;
        else console.error(`porthole: ${this.path} is invalid, ignoring it`);
      } catch {
        console.error(`porthole: ${this.path} is not JSON, ignoring it`);
      }
    }
    this.text = text;
    this.etag = etagOf(text);
  }

  get(): Overrides {
    this.reload();
    return this.doc;
  }

  /** Returns the new etag, or null when `ifMatch` is stale. */
  update(ifMatch: string, patch: Patch): string | null {
    this.reload();
    if (ifMatch !== this.etag) return null;
    const next = applyPatch(this.doc, patch);
    const text = JSON.stringify(next, null, 2) + "\n";
    writeFileAtomic(this.path, text);
    this.doc = next;
    this.text = text;
    this.etag = etagOf(text);
    return this.etag;
  }
}

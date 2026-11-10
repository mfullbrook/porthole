// porthole launcher. Plain ES module, no framework, no build step, no network beyond this origin.
// Rendering keeps one persistent DOM node per service (rows, tiles) and only rebuilds a node when
// its own data signature changes, so the 5s poll never drops scroll, expansions, the open sheet,
// keyboard focus or text being typed.

const $ = (id) => document.getElementById(id);
const OPENABLE = new Set(["verified", "inferred"]);
const STATE_WORD = { verified: "verified", inferred: "inferred", blocked: "blocked", not_responding: "not responding", no_route: "no route", identifying: "identifying", not_running: "not running" };
const POLL_MS = 5000;
const RECENT_KEY = "porthole.recent";

const S = {
  data: null,
  csrf: document.querySelector('meta[name="porthole-csrf"]')?.content || "",
  offline: false,
  httpError: null,
  lastOk: 0,
  seq: 0,
  inflight: false,
  timer: 0,
  retrying: false,
  query: "",
  searchHidden: false,
  expanded: new Set(),
  tileOpen: null,
  selKey: null,
  sheetKey: null,
  sheetReturn: null,
  renameDirty: false,
  saving: false,
  results: [],
};

const rowEls = new Map();   // key -> row element
const tileEls = new Map();  // key -> tile element
const groupEls = new Map(); // group -> { section, list }
const sigs = new WeakMap(); // element -> last signature

// ---------- small helpers ----------

function safeUrl(u) {
  if (typeof u !== "string") return null;
  try {
    const x = new URL(u, location.href);
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : null;
  } catch { return null; }
}

function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "href") { const u = safeUrl(v); if (u) n.href = u; }
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}

/** New-tab link, or plain text when the URL is not http(s). */
function extLink(url, key, cls, ...kids) {
  const u = safeUrl(url);
  if (!u) return h("span", { class: cls }, ...kids);
  return h("a", { class: cls, href: u, target: "_blank", rel: "noopener", "data-open": key || "" }, ...kids);
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function initials(name) {
  const words = String(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return "·";
  const w0 = words[0];
  if (w0.length <= 3 && w0 === w0.toUpperCase() && /\p{L}/u.test(w0)) return w0;
  let s = w0[0].toUpperCase();
  const w1 = words[1];
  if (w1 && /^\p{Lu}/u.test(w1)) s += w1[0];
  return s;
}

const isOpenable = (s) => OPENABLE.has(s.state) && !!safeUrl(s.url);
const sig = (v) => JSON.stringify(v);

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "{}") || {}; } catch { return {}; }
}
let recent = loadRecent();
function recordRecent(key) {
  if (!key) return;
  recent[key] = Date.now();
  try {
    const top = Object.entries(recent).sort((a, b) => b[1] - a[1]).slice(0, 100);
    recent = Object.fromEntries(top);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch { /* private mode etc. */ }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = h("textarea", { readonly: true, style: "position:fixed;top:0;left:0;opacity:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = old; }, 1400);
}

/** Rebuild an element's children only when its signature changed; keep focus on the same control. */
function patch(node, signature, build) {
  if (sigs.get(node) === signature) return false;
  sigs.set(node, signature);
  const active = document.activeElement;
  const fid = active && node.contains(active) ? active.dataset.fid : null;
  build(node);
  if (fid) node.querySelector(`[data-fid="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
  return true;
}

/** Make container's children exactly `nodes`, moving only what is out of place. */
function reconcile(container, nodes) {
  for (let i = 0; i < nodes.length; i++) {
    if (container.children[i] !== nodes[i]) container.insertBefore(nodes[i], container.children[i] || null);
  }
  while (container.children.length > nodes.length) container.lastElementChild.remove();
}

// ---------- pieces ----------

function stateBadge(s) {
  const label = s.label || "";
  switch (s.state) {
    case "verified": return h("span", { class: "badge verified" }, `✓ ${label || "verified"}`);
    case "inferred": return h("span", { class: "badge inferred" }, `≈ ${label || "inferred"}`);
    case "identifying": {
      const p = s.ports?.[0];
      return h("span", { class: "badge identifying" }, `identifying…${p ? ` · :${p.port} ${p.process || ""}` : ""}`);
    }
    case "not_running": return h("span", { class: "badge closed" }, `not running${s.lastSeen ? ` · last seen ${ago(s.lastSeen)}` : ""}`);
    default: return h("span", { class: "badge closed" }, `✕ ${s.reason || STATE_WORD[s.state] || s.state}`);
  }
}

function routeLine(r, key) {
  const sym = r.state === "verified" ? "✓" : r.state === "inferred" ? "≈" : "✕";
  const cls = r.state === "verified" ? "verified" : r.state === "inferred" ? "inferred" : "closed";
  const open = OPENABLE.has(r.state);
  return h("div", { class: "line" },
    open ? extLink(r.url, key, "mono", r.url) : h("span", { class: "mono" }, r.url),
    h("span", { class: `badge ${cls}` }, `${sym} ${STATE_WORD[r.state] || r.state}${r.caveat ? ` · ${r.caveat}` : ""}`));
}

function subParts(s, searching) {
  const parts = [];
  if (searching && s.group && s.group !== s.container) parts.push(s.group);
  if (s.hidden) parts.push(`hidden · ${s.hidden}`);
  if (s.worktree) {
    parts.push(h("span", { class: "chip" }, `⑂ ${s.branch || s.worktree}`));
    parts.push(`worktree ${s.worktree}`);
  } else if (s.branch) parts.push(s.branch);
  if (s.kind === "docker") parts.push(`docker${s.container ? ` · ${s.container}` : ""}`);
  else {
    const proc = (s.ports || []).find((p) => p.probe === "ok")?.process || s.ports?.[0]?.process;
    if (proc) parts.push(proc);
    if (s.kind === "launchd") parts.push("launchd");
  }
  const out = [];
  parts.forEach((p, i) => { if (i) out.push(" · "); out.push(p); });
  return out;
}

/** Reason + generated fix: inline expand of non-openable rows and tiles, and the ⓘ sheet. */
function fixBlock(s, prefix) {
  const kids = [];
  if (s.state === "not_running") {
    kids.push(h("p", null, `Not running${s.lastSeen ? ` · last seen ${ago(s.lastSeen)} (${clock(s.lastSeen)})` : ""}.`));
  } else if (s.state === "identifying") {
    const p = s.ports?.[0];
    kids.push(h("p", null, `Identifying… porthole is still probing${p ? ` :${p.port} (${p.process || "unknown"})` : " this listener"}.`));
  } else {
    kids.push(h("p", null, h("strong", null, `✕ ${STATE_WORD[s.state] || s.state}`),
      s.reason ? ` — ${s.reason}` : "", s.label ? [" · ", h("span", { class: "mono" }, s.label)] : ""));
  }
  const fix = s.fix;
  if (fix) {
    if (fix.title) kids.push(h("p", { class: "fix-title" }, fix.title));
    (fix.commands || []).forEach((c, i) => {
      kids.push(h("div", { class: "cmd" },
        c.label ? h("div", { class: "cmd-label" }, c.label) : null,
        h("div", { class: "cmd-box" },
          h("code", null, c.cmd),
          h("button", { type: "button", class: "copy", "data-act": "copy", "data-copy": c.cmd, "data-fid": `${prefix}copy-${i}`, "aria-label": `Copy command: ${c.label || c.cmd}` }, "Copy"))));
    });
    if (fix.notes?.length) kids.push(h("ul", { class: "notes" }, fix.notes.map((n) => h("li", null, n))));
  }
  return kids;
}

// ---------- rows ----------

function rowFor(s, searching) {
  let row = rowEls.get(s.key);
  if (!row) { row = h("div", { class: "row", role: "listitem", "data-key": s.key }); rowEls.set(s.key, row); }
  const open = isOpenable(s);
  const expanded = !open && S.expanded.has(s.key);
  const signature = sig([s.name, s.state, s.url, s.label, s.caveat, s.reason, s.fix, s.branch, s.worktree, s.hidden, s.group,
    s.kind, s.container, s.lastSeen && Math.floor((Date.now() - s.lastSeen) / 60000), (s.ports || []).map((p) => p.process), expanded, searching]);
  patch(row, signature, () => {
    row.className = `row ${s.state} ${open ? "open" : "closed"}`;
    const body = [
      h("span", { class: "mono-plate", "aria-hidden": "true" }, initials(s.name)),
      h("div", { class: "row-body" },
        h("div", { class: "name" }, s.name, open ? h("span", { class: "ne", "aria-hidden": "true" }, "↗") : null),
        h("div", { class: "sub" }, subParts(s, searching)),
        h("div", { class: "route" }, stateBadge(s), open && s.caveat ? h("span", { class: "pill" }, s.caveat) : null)),
    ];
    const main = open
      ? extLink(s.url, s.key, "row-link", ...body)
      : h("button", { type: "button", class: "row-link", "data-act": "toggle", "data-key": s.key, "aria-expanded": String(expanded) },
        ...body, h("span", { class: "caret", "aria-hidden": "true" }, expanded ? "▴" : "▾"));
    main.dataset.fid = "main";
    if (open) main.setAttribute("aria-label", `${s.name}, opens in a new tab`);
    const info = h("button", { type: "button", class: "info", "data-act": "info", "data-key": s.key, "data-fid": "info", "aria-label": `Details for ${s.name}` }, "ⓘ");
    row.replaceChildren(h("div", { class: "row-main" }, main, info));
    if (expanded) row.append(h("div", { class: "expand" }, fixBlock(s, "")));
  });
  row.classList.toggle("sel", S.query.trim() !== "" && effectiveSel() === s.key);
  return row;
}

// ---------- tiles ----------

function tileFor(s) {
  let tile = tileEls.get(s.key);
  const open = isOpenable(s);
  // Openable tiles are <a>, the rest <button>; swap the element when that flips.
  if (tile && (tile.tagName === "A") !== open) { tile.remove(); tile = null; }
  if (!tile) {
    tile = open ? h("a", { target: "_blank", rel: "noopener" }) : h("button", { type: "button", "data-act": "tile" });
    tile.dataset.key = s.key;
    tileEls.set(s.key, tile);
  }
  const signature = sig([s.name, s.state, s.url, s.label, s.caveat, s.reason, S.tileOpen === s.key]);
  patch(tile, signature, () => {
    const cls = s.state === "verified" ? "verified" : s.state === "inferred" ? "inferred" : "closed";
    tile.className = `tile ${cls} ${s.state}`;
    if (open) {
      tile.href = safeUrl(s.url);
      tile.dataset.open = s.key;
      tile.setAttribute("aria-label", `${s.name}, opens in a new tab${s.caveat ? ` (${s.caveat})` : ""}`);
      tile.title = `${s.state === "inferred" ? "≈" : "✓"} ${s.label || s.url}${s.caveat ? ` · ${s.caveat}` : ""}`;
    } else {
      tile.setAttribute("aria-expanded", String(S.tileOpen === s.key));
      tile.setAttribute("aria-label", `${s.name}: ${s.state === "not_running" ? "not running" : s.reason || STATE_WORD[s.state]}`);
    }
    const mark = open ? (s.state === "inferred" ? "≈ ↗" : "↗") : s.state === "identifying" ? "…" : "✕";
    tile.replaceChildren(
      h("span", { class: open ? "ne" : "sym", "aria-hidden": "true" }, mark),
      h("span", { class: "mono-plate", "aria-hidden": "true" }, initials(s.name)),
      h("span", { class: "t" }, s.name));
  });
  return tile;
}

function renderTilePanel(byKey) {
  const panel = $("tilepanel");
  const s = S.tileOpen && byKey.get(S.tileOpen);
  if (!s || isOpenable(s) || !s.pinned) { S.tileOpen = null; panel.replaceChildren(); sigs.delete(panel); return; }
  patch(panel, sig([s.key, s.name, s.state, s.reason, s.fix, s.label, s.lastSeen && Math.floor((Date.now() - s.lastSeen) / 60000)]), () => {
    panel.replaceChildren(h("div", { class: "tilenote" },
      h("div", { class: "tn-head" }, h("span", { class: "grow" }, s.name),
        h("button", { type: "button", class: "info", style: "border-left:0", "data-act": "info", "data-key": s.key, "data-fid": "tinfo", "aria-label": `Details for ${s.name}` }, "ⓘ")),
      h("div", { class: "expand", style: "border-top:0" }, fixBlock(s, "t"))));
  });
}

// ---------- search ----------

function words(s) { return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean); }
function wordPrefix(text, q) {
  if (text.startsWith(q)) return true;
  const i = text.indexOf(q);
  if (i < 0) return false;
  // any occurrence that starts right after a non-alphanumeric character
  let at = i;
  while (at >= 0) {
    if (at === 0 || /[^\p{L}\p{N}]/u.test(text[at - 1])) return true;
    at = text.indexOf(q, at + 1);
  }
  return false;
}

function score(s, q) {
  const name = s.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (wordPrefix(name, q)) return 1;
  const qp = q.replace(/^:/, "");
  const fields = [s.project, s.branch, s.worktree, s.container, s.launchdLabel,
    ...(s.ports || []).flatMap((p) => [p.process, String(p.port)])].filter(Boolean).map((f) => String(f).toLowerCase());
  if (fields.some((f) => f.startsWith(qp) || wordPrefix(f, qp))) return 2;
  const extra = [s.derivedName, s.label].filter(Boolean).map((f) => String(f).toLowerCase());
  if (name.includes(q) || [...fields, ...extra].some((f) => f.includes(q))) return 3;
  return -1;
}

function search(services, query) {
  const q = query.trim().toLowerCase();
  const pool = services.filter((s) => S.searchHidden || !s.hidden);
  const hits = [];
  for (const s of pool) {
    const sc = score(s, q);
    if (sc >= 0) hits.push({ s, sc });
  }
  hits.sort((a, b) => a.sc - b.sc
    || (b.s.pinned - a.s.pinned)
    || (isOpenable(b.s) - isOpenable(a.s))
    || ((recent[b.s.key] || 0) - (recent[a.s.key] || 0))
    || a.s.name.localeCompare(b.s.name, undefined, { sensitivity: "base" }));
  return hits.map((x) => x.s);
}

/** Highlighted result: the user's arrow-key choice, else the top openable hit, else the top hit. */
function effectiveSel() {
  const r = S.results;
  if (S.selKey && r.some((s) => s.key === S.selKey)) return S.selKey;
  return (r.find(isOpenable) || r[0])?.key ?? null;
}

// ---------- banners and footer ----------

function renderBanners() {
  const d = S.data;
  const specs = [];
  if (S.offline) specs.push(["offline", S.httpError ? `Daemon answered ${S.httpError}.` : "Offline: daemon unreachable.",
    S.lastOk ? ` Showing the list from ${clock(d?.scannedAt || S.lastOk)}.` : "", true]);
  if (d?.stale) specs.push(["stale", `Snapshot from ${clock(d.scannedAt)} may be out of date${d.error ? `: ${d.error}` : "."}`, "", true]);
  for (const w of d?.warnings || []) specs.push(["warn", `⚠ ${w.message || w.source}`, "", false]);
  const box = $("banners");
  patch(box, sig([specs, S.retrying]), () => {
    box.replaceChildren(...specs.map(([kind, text, extra, retry]) => h("div", { class: `banner ${kind === "warn" ? "quiet" : ""}`, "data-kind": kind },
      h("span", { class: "grow" }, text, extra),
      retry ? h("button", { type: "button", class: "btn", "data-act": "retry", "data-fid": `retry-${kind}`, disabled: S.retrying }, S.retrying ? "Retrying…" : "Retry") : null)));
  });
}

function renderFooter(visibleCount, hiddenCount) {
  const d = S.data;
  if (!d) { $("status").textContent = ""; return; }
  const when = d.scannedAt ? `updated ${ago(d.scannedAt)}` : "not scanned yet";
  $("status").textContent = `${visibleCount} service${visibleCount === 1 ? "" : "s"} · ${hiddenCount} hidden · ${when}`;
}

// ---------- main render ----------

function render() {
  const d = S.data;
  const services = d?.services || [];
  const byKey = new Map(services.map((s) => [s.key, s]));
  const searching = S.query.trim() !== "";

  if (d) {
    const host = $("host");
    host.hidden = false;
    host.textContent = d.viewer === "local" ? `${d.host} · this Mac` : d.host;
    host.title = d.fqdn || d.host;
  }
  renderBanners();
  $("scanning").hidden = !(!d || (d.scanning && !services.length));
  $("scanning").textContent = !d && S.offline ? "Daemon unreachable." : "Scanning…";

  // forget per-service UI for services that are gone
  for (const [k, n] of rowEls) if (!byKey.has(k)) { n.remove(); rowEls.delete(k); S.expanded.delete(k); }
  for (const [k, n] of tileEls) if (!byKey.get(k)?.pinned) { n.remove(); tileEls.delete(k); }

  const shown = services.filter((s) => !s.hidden && s.state !== "not_running");
  const hidden = services.filter((s) => s.hidden);

  $("pinned").hidden = searching || !services.some((s) => s.pinned);
  $("groups").hidden = searching;
  $("hidden").hidden = searching || !hidden.length;
  $("search").hidden = !searching;
  $("meta").hidden = !searching;

  if (searching) {
    S.results = search(services, S.query);
    reconcile($("results"), S.results.map((s) => rowFor(s, true)));
    $("nomatch").hidden = S.results.length > 0;
    $("count").textContent = `${S.results.length} match${S.results.length === 1 ? "" : "es"}`;
  } else {
    S.results = [];
    reconcile($("results"), []);
    reconcile($("tiles"), services.filter((s) => s.pinned).map(tileFor));
    renderTilePanel(byKey);

    const order = [];
    const byGroup = new Map();
    for (const s of shown) {
      if (!byGroup.has(s.group)) { byGroup.set(s.group, []); order.push(s.group); }
      byGroup.get(s.group).push(s);
    }
    const sections = order.map((g) => {
      let ge = groupEls.get(g);
      if (!ge) {
        const list = h("div", { class: "list", role: "list" });
        ge = { section: h("section", { "aria-label": g }, h("h2", { class: "group" }, g), list), list };
        groupEls.set(g, ge);
      }
      reconcile(ge.list, byGroup.get(g).map((s) => rowFor(s, false)));
      return ge.section;
    });
    for (const [g] of groupEls) if (!byGroup.has(g)) groupEls.delete(g);
    reconcile($("groups"), sections);

    $("hiddencount").textContent = String(hidden.length);
    reconcile($("hiddenrows"), hidden.map((s) => rowFor(s, false)));
  }
  renderFooter(shown.length, hidden.length);
  if (S.sheetKey) renderSheet();
}

// ---------- details sheet ----------

function kv(dt, ...dd) { return [h("dt", null, dt), h("dd", null, ...dd)]; }

function renderSheet() {
  const s = S.data?.services.find((x) => x.key === S.sheetKey);
  const d = S.data;
  $("sheet-title").textContent = s ? s.name : "Service gone";
  const body = $("sheet-body");
  const open = s && isOpenable(s);
  patch(body, sig([s, d?.host, s?.checkedAt && Math.floor((Date.now() - s.checkedAt) / 10000)]), () => {
    if (!s) { body.replaceChildren(h("p", { class: "sheet-msg" }, "This service is no longer listed. It may have stopped.")); return; }
    const items = [];
    if (open) {
      items.push(kv("Open",
        h("div", { class: "line" }, extLink(s.url, s.key, "", s.url), h("span", { "aria-hidden": "true" }, "↗")),
        h("div", { class: "line" }, stateBadge(s), s.caveat ? h("span", { class: "pill" }, s.caveat) : null),
        s.checkedAt ? h("div", { class: "line small" }, `reachable from ${d.host} ${ago(s.checkedAt)}`) : null));
    } else {
      items.push(kv("Status", h("div", { class: "line" }, stateBadge(s))));
    }
    const others = (s.routes || []).filter((r) => r.url !== s.url);
    if (others.length) items.push(kv(open ? "Also" : "Routes", others.map((r) => routeLine(r, s.key))));
    if (s.localUrl) items.push(kv("On the Mac mini", h("div", { class: "line" }, h("span", { class: "mono" }, s.localUrl),
      h("button", { type: "button", class: "btn quiet", style: "min-height:32px;padding:2px 10px", "data-act": "copy", "data-copy": s.localUrl, "data-fid": "copy-local" }, "Copy"))));
    if (s.fallbackUrl) items.push(kv("Fallback", h("div", { class: "line" }, extLink(s.fallbackUrl, s.key, "mono", s.fallbackUrl)),
      h("div", { class: "small" }, "Tailscale IP, for devices without MagicDNS")));
    if (s.project) items.push(kv("Repo", s.project, s.worktree ? h("span", { class: "small" }, ` (worktree ${s.worktree})`) : null));
    if (s.branch) items.push(kv("Branch", h("span", { class: "chip" }, `⑂ ${s.branch}`)));
    items.push(kv("Group", s.group));
    const kindBits = [s.kind, s.container && `container ${s.container}`, s.launchdLabel].filter(Boolean).join(" · ");
    items.push(kv("Kind", kindBits));
    const procs = [...new Set((s.ports || []).map((p) => p.process).filter(Boolean))];
    if (procs.length || s.pid) items.push(kv("Process", [procs.join(", "), s.pid ? `pid ${s.pid}` : ""].filter(Boolean).join(" · ")));
    if (s.command) items.push(kv("Command", h("span", { class: "mono small" }, s.command)));
    if (s.cwd) items.push(kv("cwd", h("span", { class: "mono small" }, s.cwd)));
    if (s.ports?.length) items.push(kv("Ports", s.ports.map((p) => h("div", { class: "line" },
      h("span", { class: "mono" }, `:${p.port}`),
      h("span", { class: "small" }, [p.process, (p.binds || []).join(", "), p.scheme, p.status != null ? String(p.status) : p.probe].filter(Boolean).join(" · ")),
      p.title ? h("span", { class: "small" }, `“${p.title}”`) : null))));
    if (s.hidden) items.push(kv("Hidden", s.hidden));
    if (s.lastSeen) items.push(kv("Last seen", `${clock(s.lastSeen)} (${ago(s.lastSeen)})`));
    items.push(kv("Key", h("span", { class: "mono small" }, s.key)));
    const parts = [];
    if (!open && (s.fix || s.reason || s.state === "identifying" || s.state === "not_running")) parts.push(h("div", { class: "fixbox" }, fixBlock(s, "s")));
    parts.push(h("dl", { class: "kv" }, items));
    body.replaceChildren(...parts);
  });

  const busy = S.saving || !s;
  $("act-pin").textContent = s?.pinned ? "Unpin" : "Pin";
  $("act-hide").textContent = s?.hidden ? "Unhide" : "Hide";
  $("act-copy").disabled = !s?.url;
  for (const id of ["act-pin", "act-hide", "act-reset"]) $(id).disabled = busy;
  $("rename-form").querySelector("button[type=submit]").disabled = busy;
  const input = $("rename");
  input.placeholder = s?.derivedName || "";
  if (s && !S.renameDirty && document.activeElement !== input) input.value = s.name;
}

function openSheet(key) {
  const fresh = S.sheetKey !== key;
  S.sheetKey = key;
  if (fresh) {
    S.sheetReturn = document.activeElement;
    S.renameDirty = false;
    sigs.delete($("sheet-body"));
    $("rename").value = "";
    setMsg("");
  }
  $("scrim").hidden = false;
  $("sheet").hidden = false;
  document.body.classList.add("locked");
  renderSheet();
  $("sheet").scrollTop = 0;
  $("sheet").focus({ preventScroll: true });
}

function closeSheet() {
  if (!S.sheetKey) return;
  S.sheetKey = null;
  $("scrim").hidden = true;
  $("sheet").hidden = true;
  document.body.classList.remove("locked");
  const back = S.sheetReturn;
  S.sheetReturn = null;
  if (back && document.contains(back)) back.focus({ preventScroll: true });
}

function setMsg(text, err = false) {
  const m = $("sheet-msg");
  m.textContent = text;
  m.classList.toggle("err", err);
}

async function putOverride(key, set, retried = false) {
  S.saving = true;
  renderSheet();
  setMsg("Saving…");
  try {
    let res;
    try {
      res = await fetch("/api/overrides", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Porthole-CSRF": S.csrf, "If-Match": S.data?.overridesEtag || "*" },
        body: JSON.stringify({ key, set }),
      });
    } catch {
      setMsg("Not saved: daemon unreachable.", true);
      return false;
    }
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      if (j.etag && S.data) S.data.overridesEtag = j.etag;
      await load();
      setMsg("Saved.");
      return true;
    }
    if (res.status === 403 && !retried) {
      await load(); // picks up a fresh csrf token after a daemon restart
      S.saving = false;
      return await putOverride(key, set, true);
    }
    if (res.status === 409) {
      await load();
      setMsg("Changed elsewhere: reloaded the latest settings. Check and try again.", true);
      return false;
    }
    const text = (await res.text().catch(() => "")).slice(0, 200);
    setMsg(`Not saved (${res.status}${text ? `: ${text}` : ""}).`, true);
    return false;
  } finally {
    S.saving = false;
    if (S.sheetKey) renderSheet();
  }
}

function currentSheetService() { return S.data?.services.find((x) => x.key === S.sheetKey); }

// ---------- data ----------

async function load(fresh = false) {
  const seq = ++S.seq;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), fresh ? 8000 : 6000);
  try {
    const res = await fetch(`/api/services${fresh ? "?fresh=1" : ""}`, { credentials: "same-origin", cache: "no-store", signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) { const e = new Error("http"); e.status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`; throw e; }
    const j = await res.json();
    if (seq !== S.seq) return;
    S.data = j;
    if (typeof j.csrf === "string" && j.csrf) S.csrf = j.csrf;
    S.offline = false;
    S.httpError = null;
    S.lastOk = Date.now();
  } catch (e) {
    if (seq !== S.seq) return;
    S.offline = true;
    S.httpError = e?.status || null;
  } finally {
    clearTimeout(t);
  }
  render();
}

async function tick() {
  if (S.inflight) return;
  S.inflight = true;
  clearTimeout(S.timer);
  try { await load(); } finally { S.inflight = false; }
  schedule();
}

function schedule() {
  clearTimeout(S.timer);
  if (document.visibilityState === "visible") S.timer = setTimeout(tick, POLL_MS);
}

// ---------- events ----------

function toggleRow(key) {
  if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
  render();
}

document.addEventListener("click", async (ev) => {
  const t = ev.target instanceof Element ? ev.target : null;
  if (!t) return;
  const link = t.closest("a[data-open]");
  if (link) { recordRecent(link.dataset.open); return; }
  const btn = t.closest("[data-act]");
  if (!btn) return;
  const key = btn.dataset.key;
  switch (btn.dataset.act) {
    case "toggle": toggleRow(key); break;
    case "info": openSheet(key); break;
    case "tile": S.tileOpen = S.tileOpen === btn.dataset.key ? null : btn.dataset.key; render(); break;
    case "copy": flash(btn, (await copyText(btn.dataset.copy || "")) ? "Copied" : "Copy failed"); break;
    case "retry":
      S.retrying = true; renderBanners();
      try { await load(true); } finally { S.retrying = false; renderBanners(); }
      break;
  }
});
document.addEventListener("auxclick", (ev) => {
  const link = ev.target instanceof Element && ev.target.closest("a[data-open]");
  if (link && ev.button === 1) recordRecent(link.dataset.open);
});

$("scrim").addEventListener("click", closeSheet);
$("sheet-close").addEventListener("click", closeSheet);
$("act-copy").addEventListener("click", async (ev) => {
  const s = currentSheetService();
  if (s?.url) flash(ev.currentTarget, (await copyText(s.url)) ? "Copied" : "Copy failed");
});
$("act-pin").addEventListener("click", () => {
  const s = currentSheetService();
  if (s) putOverride(s.key, { pin: s.pinned ? null : true });
});
$("act-hide").addEventListener("click", () => {
  const s = currentSheetService();
  if (!s) return;
  // Unhide: clear the user's own hide; override a rule-based hide with an explicit "show".
  putOverride(s.key, { hide: s.hidden ? (s.hidden === "hidden by you" ? null : false) : true });
});
$("rename").addEventListener("input", () => { S.renameDirty = true; });
$("rename-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const s = currentSheetService();
  if (!s) return;
  const v = $("rename").value.trim();
  const ok = await putOverride(s.key, { rename: v && v !== s.derivedName ? v : null });
  if (ok) { S.renameDirty = false; renderSheet(); }
});
$("act-reset").addEventListener("click", async () => {
  const s = currentSheetService();
  if (!s) return;
  const ok = await putOverride(s.key, { rename: null });
  if (ok) { S.renameDirty = false; $("rename").value = s.derivedName; renderSheet(); }
});

const q = $("q");
q.addEventListener("input", () => {
  S.query = q.value;
  S.selKey = null;
  render();
});
$("searchhidden").addEventListener("change", (ev) => { S.searchHidden = ev.target.checked; render(); });

function activate(key) {
  const row = rowEls.get(key);
  const s = S.data?.services.find((x) => x.key === key);
  if (!row || !s) return;
  if (isOpenable(s)) row.querySelector("a[data-open]")?.click();
  else if (!S.expanded.has(key)) toggleRow(key);
}

function moveSel(delta) {
  const r = S.results;
  if (!r.length) return;
  const cur = document.activeElement === q ? -1 : r.findIndex((s) => s.key === S.selKey);
  const next = cur + delta;
  if (next < 0) { S.selKey = null; q.focus(); render(); return; }
  S.selKey = r[Math.min(next, r.length - 1)].key;
  render();
  rowEls.get(S.selKey)?.querySelector('[data-fid="main"]')?.focus();
}

const editable = (n) => n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable);

document.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const a = document.activeElement;
  if (S.sheetKey) {
    if (ev.key === "Escape") { ev.preventDefault(); closeSheet(); }
    return;
  }
  const searching = S.query.trim() !== "";
  const inResults = a && $("results").contains(a);
  if (ev.key === "/" && !editable(a)) { ev.preventDefault(); q.focus(); q.select(); return; }
  if (ev.key === "Escape") {
    if (S.query) { ev.preventDefault(); q.value = ""; S.query = ""; S.selKey = null; render(); q.focus(); }
    else if (a === q) q.blur();
    return;
  }
  if (!searching) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    if (a === q || inResults) { ev.preventDefault(); moveSel(ev.key === "ArrowDown" ? 1 : -1); }
    return;
  }
  if (ev.key === "Enter" && a === q) {
    ev.preventDefault();
    const r = S.results;
    const target = (S.selKey && r.find((s) => s.key === S.selKey)) || r.find(isOpenable) || r[0];
    if (target) activate(target.key);
    return;
  }
  if (inResults) {
    if (ev.key === "i") { ev.preventDefault(); const k = a.closest("[data-key]")?.dataset.key; if (k) openSheet(k); return; }
    if (ev.key.length === 1 && ev.key !== " ") q.focus(); // keep typing into the search box
  }
});

// keep the arrow-key selection in step with focus moved by Tab or pointer
document.addEventListener("focusin", (ev) => {
  const row = ev.target instanceof Element && $("results").contains(ev.target) && ev.target.closest(".row");
  if (row && row.dataset.key !== S.selKey) { S.selKey = row.dataset.key; for (const r of $("results").children) r.classList.toggle("sel", r === row); }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tick(); else clearTimeout(S.timer);
});

// Desktop (fine pointer with hover): focus search on load. Touch devices: never autofocus.
if (matchMedia("(hover: hover) and (pointer: fine)").matches) q.focus({ preventScroll: true });

render();
tick();

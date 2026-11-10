// Response bodies that mean "this answers, but it is not the app".

export interface Signature {
  id: string;
  test: (body: string, title: string | null) => boolean;
  /** Caveat shown on the row. */
  caveat: string;
  /** "host" = the server refused our Host header; "not_app" = wrong server. */
  kind: "host" | "not_app";
}

export const SIGNATURES: Signature[] = [
  {
    id: "vite-blocked-host",
    test: (b) => /Blocked request\. This host \(.*?\) is not allowed/.test(b),
    caveat: "host not allowed",
    kind: "host",
  },
  {
    id: "invalid-host-header",
    test: (b) => /^\s*Invalid Host header\s*$/.test(b) || b.startsWith("Invalid Host header"),
    caveat: "host not allowed",
    kind: "host",
  },
  {
    id: "laravel-vite-placeholder",
    test: (b, t) =>
      t === "Laravel Vite" ||
      b.includes("This is the Vite development server that provides Hot Module Replacement for your Laravel application"),
    caveat: "not the app: Vite asset server",
    kind: "not_app",
  },
];

export function matchSignature(body: string, title: string | null): Signature | null {
  return SIGNATURES.find((s) => s.test(body, title)) ?? null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const t = m[1]!
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (ENTITIES[e]) return ENTITIES[e]!;
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return all;
    })
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

export function extractFavicon(html: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) return href[1]!;
  }
  return null;
}

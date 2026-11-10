// One HTTP GET with the outcome classified the way the verifier needs it.
// Tests swap in a fake HttpClient; the daemon uses bunHttp.

export type FetchOutcome =
  | { kind: "refused" }
  | { kind: "timeout" }
  /** Connection closed or reset before an HTTP response (curl 52): often TLS-only. */
  | { kind: "reset"; message: string }
  /** TLS handshake failure other than certificate validation. */
  | { kind: "tls"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "response";
      status: number;
      contentType: string | null;
      location: string | null;
      body: string; // first BODY_LIMIT bytes
      /** HTTPS only: why the certificate failed validation, or null when it validated. */
      certError: string | null;
    };

export interface GetOptions {
  /** Override the Host header (local candidates fetched by address). */
  host?: string;
  timeoutMs?: number;
  /** Skip certificate validation entirely (identity probe). */
  insecure?: boolean;
}

export type HttpClient = (url: string, opts?: GetOptions) => Promise<FetchOutcome>;

const BODY_LIMIT = 128 * 1024;
const CERT_ERROR = /CERT|SELF_SIGNED|ALTNAME|HOSTNAME|UNABLE_TO_(VERIFY|GET)|ERR_TLS_CERT/i;

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, BODY_LIMIT));
}

function classifyError(e: unknown): FetchOutcome {
  const err = e as { name?: string; code?: string; message?: string };
  const code = err?.code ?? "";
  const msg = `${code} ${err?.message ?? String(e)}`.trim();
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || code === "ETIMEDOUT") return { kind: "timeout" };
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return { kind: "refused" };
  if (code === "ECONNRESET" || /closed unexpectedly|socket hang up/i.test(msg)) return { kind: "reset", message: msg };
  if (/TLS|SSL|handshake/i.test(msg)) return { kind: "tls", message: msg };
  return { kind: "error", message: msg };
}

export function certCaveat(code: string): string {
  if (/SELF_SIGNED|DEPTH_ZERO/i.test(code)) return "self-signed certificate";
  if (/EXPIRED/i.test(code)) return "certificate expired";
  if (/ALTNAME|HOSTNAME/i.test(code)) return "certificate name mismatch";
  return "untrusted certificate";
}

async function once(url: string, opts: GetOptions, insecure: boolean): Promise<FetchOutcome> {
  try {
    const headers: Record<string, string> = { "user-agent": "porthole/0.1", accept: "text/html,*/*" };
    if (opts.host) headers.host = opts.host;
    const res = await fetch(url, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
      tls: insecure ? { rejectUnauthorized: false } : undefined,
    } as RequestInit);
    const body = await readLimited(res);
    return {
      kind: "response",
      status: res.status,
      contentType: res.headers.get("content-type"),
      location: res.headers.get("location"),
      body,
      certError: null,
    };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const code = `${err?.code ?? ""} ${err?.message ?? ""}`;
    if (!insecure && url.startsWith("https:") && CERT_ERROR.test(code)) {
      // Read the response anyway, and remember why the certificate failed.
      const r = await once(url, opts, true);
      if (r.kind === "response") return { ...r, certError: certCaveat(err?.code ?? code) };
      return r;
    }
    return classifyError(e);
  }
}

export const bunHttp: HttpClient = (url, opts = {}) => once(url, opts, opts.insecure ?? false);

export function urlHost(addr: string): string {
  return addr.includes(":") ? `[${addr}]` : addr;
}

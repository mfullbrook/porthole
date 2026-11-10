// Run an external command by absolute path with a timeout. Never through a shell.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function exec(argv: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<ExecResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      // The GUI Tailscale.app binary only acts as a CLI when TERM is set; without
      // it (launchd sets none) it tries to start the GUI and prints an error.
      env: { ...process.env, TERM: process.env.TERM || "dumb", LC_ALL: "C" },
    });
  } catch (e) {
    return { code: 127, stdout: "", stderr: String((e as Error).message ?? e), timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, opts.timeoutMs ?? 5000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
}

export function brief(r: ExecResult): string {
  if (r.timedOut) return "timed out";
  return (r.stderr.trim().split("\n")[0] || `exit ${r.code}`).slice(0, 200);
}

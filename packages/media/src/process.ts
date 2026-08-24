import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runProcess(command: string, args: string[], options: { timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal; onStderr?: (text: string) => void; cwd?: string } = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason instanceof Error ? options.signal.reason : new Error(`${command} cancelled`));
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000).unref();
    };
    const onAbort = () => { cancelled = true; terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", (chunk: Buffer) => { collect(stderr)(chunk); options.onStderr?.(chunk.toString("utf8")); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? -1 };
      if (cancelled) reject(new Error(`${command} cancelled`));
      else if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      else if (outputBytes > maxOutputBytes) reject(new Error(`${command} exceeded output limit`));
      else resolve(result);
    });
  });
}

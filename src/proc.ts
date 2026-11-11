// SPDX-License-Identifier: GPL-3.0-or-later
// Re-spawning ourselves: compiled binary vs `bun src/index.ts`, restarts with extra env vars.
import { spawn } from "node:child_process";
import { err } from "./colors";

export function isCompiledBinary(): boolean {
  const script = process.argv[1] ?? "";
  return !script || script.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(script);
}

/** argv needed to start this program again: [script] in dev mode, [] for a compiled binary. */
export function programArgs(): string[] {
  const script = process.argv[1];
  return isCompiledBinary() || !script ? [] : [script];
}

/**
 * Restart this program (optionally from another executable) with extra env vars, wait for it, and
 * exit with its exit code. Never resolves. One of the few places that calls process.exit directly:
 * this process is only a wrapper around the child at this point.
 */
export function reExec(extraEnv: Record<string, string>, execPath = process.execPath): Promise<never> {
  // The parent already handled --reset; don't wipe the fresh config again.
  const args = [...programArgs(), ...process.argv.slice(2).filter((a) => a !== "--reset")];
  const child = spawn(execPath, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => child.kill(sig));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", (e) => {
    console.error(err.red(`Failed to start ${execPath}: ${e.message}`));
    process.exit(1);
  });
  return new Promise<never>(() => {});
}

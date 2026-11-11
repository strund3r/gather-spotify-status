// SPDX-License-Identifier: GPL-3.0-or-later
// The log file next to the config: opened by the launcher, inherited as stdout/stderr by the daemon.
import fs from "node:fs";
import util from "node:util";
import { ensurePrivateDir } from "./fsutil";
import { stamp } from "./logger";
import { configDir, logPath } from "./paths";

/** Rotate to <log>.1 when the log grows past this size. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Open the log file for appending (mode 0600), rotating it to .1 when over MAX_LOG_BYTES. */
export function openLog(file = logPath(), dir = configDir()): number {
  ensurePrivateDir(dir);
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
  const fd = fs.openSync(file, "a", 0o600);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return fd;
}

/** Append one timestamped line. Never throws. */
export function logLine(fd: number, message: string): void {
  try {
    fs.writeSync(fd, `${stamp()} ${message}\n`);
  } catch {
    // never let logging crash the app
  }
}

/** Prefix console output with a timestamp (used by the daemon, whose stdout is the log file). */
export function timestampConsole(): void {
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(`${stamp()} ${util.format(...args)}`);
  }
}

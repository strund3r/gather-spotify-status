// SPDX-License-Identifier: GPL-3.0-or-later
// File helpers for private data (config, PID file with the control token, caches).
import fs from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

/** Create `dir` (and parents) readable only by the user (0700 on POSIX). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Write `data` to `file` atomically (tmp file + rename) with mode 0600, creating the directory (0700).
 * A crash mid-write leaves the old file intact.
 */
export function writePrivateFile(file: string, data: string): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  if (!isWindows) fs.chmodSync(tmp, 0o600); // mode is ignored when tmp already existed
  fs.renameSync(tmp, file);
}

export function writePrivateJson(file: string, value: unknown, pretty = false): void {
  writePrivateFile(file, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

/** Parsed JSON of `file`, or undefined if it's missing, unreadable or not valid JSON. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Delete a file; true if it existed. Never throws. */
export function removeFile(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

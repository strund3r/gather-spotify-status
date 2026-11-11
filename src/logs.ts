// SPDX-License-Identifier: GPL-3.0-or-later
// --logs [-n N]: print the last N lines of the log file, then follow it (like tail -f, cross-platform).
import fs from "node:fs";
import { out } from "./colors";
import { logPath } from "./paths";

export const DEFAULT_LOG_LINES = 50;
const FOLLOW_INTERVAL_MS = 500;

export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/**
 * Returns a function that, on each call, writes whatever was appended to `file` since the last call.
 * Handles rotation (file shrank → start from the top) and the file disappearing for a moment.
 */
export function logFollower(file: string, startAt: number, write: (chunk: Buffer) => void): () => void {
  let pos = startAt;
  return () => {
    try {
      const size = fs.statSync(file).size;
      if (size < pos) pos = 0; // rotated
      if (size === pos) return;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        pos = size;
        write(buf);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // missing (being rotated or not created yet): try again next time
    }
  };
}

/** Never resolves; Ctrl+C exits. */
export async function followLogs(n: number, file = logPath()): Promise<never> {
  console.log(out.dim(`${file}  (Ctrl+C to stop)`));
  let start = 0;
  try {
    const text = fs.readFileSync(file, "utf8");
    const tail = lastLines(text, n);
    if (tail) process.stdout.write(`${tail}\n`);
    start = Buffer.byteLength(text);
  } catch {
    console.log(out.dim("(no log yet; waiting for it to be created)"));
  }
  const read = logFollower(file, start, (chunk) => process.stdout.write(chunk));
  setInterval(read, FOLLOW_INTERVAL_MS);
  return new Promise<never>(() => {});
}

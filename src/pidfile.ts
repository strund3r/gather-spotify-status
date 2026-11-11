// SPDX-License-Identifier: GPL-3.0-or-later
// PID file of the running instance: {pid, version, port, token}. Mode 0600 (holds the control token).
import fs from "node:fs";
import { APP_NAME } from "./constants";
import { readJson, removeFile, writePrivateJson } from "./fsutil";
import { pidPath } from "./paths";
import { errorCode, isRecord } from "./util";
import { VERSION } from "./version";

export interface Instance {
  pid: number;
  version: string;
  /** Control channel (see control.ts). Optional: without it, --stop falls back to SIGTERM. */
  port?: number;
  token?: string;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM"; // exists, but owned by someone else
  }
}

/** On Linux, guard against PID reuse by checking the process really is us. */
function looksLikeUs(pid: number): boolean {
  if (process.platform !== "linux") return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (cmdline.includes(APP_NAME) || /index\.(js|ts)/.test(cmdline)) return true;
    const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes("GSS_DAEMON=1");
  } catch {
    return true; // can't tell; assume it is
  }
}

export function readPidFile(file = pidPath()): Instance | null {
  const data = readJson(file);
  if (!isRecord(data) || !Number.isInteger(data.pid)) return null;
  return {
    pid: Number(data.pid),
    version: typeof data.version === "string" ? data.version : "?",
    port: Number.isInteger(data.port) ? Number(data.port) : undefined,
    token: typeof data.token === "string" ? data.token : undefined,
  };
}

/** The running instance, if any (never this process). Removes a stale PID file. */
export function runningInstance(file = pidPath()): Instance | null {
  const inst = readPidFile(file);
  if (!inst || inst.pid === process.pid) return null;
  if (isAlive(inst.pid) && looksLikeUs(inst.pid)) return inst;
  removeFile(file);
  return null;
}

export function writePidFile(control?: { port: number; token: string }, file = pidPath()): void {
  writePrivateJson(file, { pid: process.pid, version: VERSION, ...control });
}

/** Remove the PID file, but only if it's ours. */
export function removePidFile(file = pidPath()): void {
  if (readPidFile(file)?.pid === process.pid) removeFile(file);
}

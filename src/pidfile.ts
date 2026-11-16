// SPDX-License-Identifier: GPL-3.0-or-later
// PID file of the running instance: {pid, version, port, token}. Mode 0600 (holds the control token).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

function matchesAppProcess(name: string): boolean {
  const base = path.basename(name).toLowerCase();
  return base.includes(APP_NAME) || base === "bun" || base === "bun.exe" || base === "node" || base === "node.exe";
}

/** Guard against PID reuse by checking the process executable is ours (or bun/node in dev mode). */
export function looksLikeUs(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.includes(APP_NAME) || /index\.(js|ts)/.test(cmdline)) return true;
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      return environ.split("\0").includes("GSS_DAEMON=1");
    } catch {
      return true; // can't tell; assume it is
    }
  }
  if (process.platform === "darwin") {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 2000 });
    if (r.status === 0 && r.stdout.trim()) return matchesAppProcess(r.stdout.trim());
    return true; // indeterminate: don't discard a potentially valid PID
  }
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    if (r.status === 0) {
      const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout.trim());
      if (m?.[1] && Number(m[2]) === pid) return matchesAppProcess(m[1]);
    }
    return true; // indeterminate (e.g. localized/missing CSV row): assume ours
  }
  return true;
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

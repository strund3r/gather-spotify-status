// SPDX-License-Identifier: GPL-3.0-or-later
// Background process: launcher ↔ daemon handshake (IPC), and the commands that talk to a running
// instance (--stop, --pause/--resume/--set reload, --status).
import { spawn } from "node:child_process";
import { err, out } from "./colors";
import { type Config, secretStorage } from "./config";
import { APP_NAME } from "./constants";
import { controlRequest, isStatusPayload } from "./control";
import { logPath } from "./paths";
import { isAlive, runningInstance } from "./pidfile";
import { programArgs } from "./proc";
import { keychainName } from "./secrets";
import type { TokenSet } from "./spotify";
import { describeStatus } from "./status";
import { errorMessage, isRecord, sleep } from "./util";

export interface DaemonInit {
  tokens: TokenSet;
  cfg: Config;
  debug: boolean;
}

type InitMessage = { type: "init" } & DaemonInit;
type ReadyMessage = { type: "ready" };

/** How long the launcher waits for the daemon to connect to Gather. */
const READY_TIMEOUT_MS = 30_000;
/** How long the daemon waits for its startup data. */
const INIT_TIMEOUT_MS = 10_000;
/** How long --stop waits for the process to exit. */
const STOP_TIMEOUT_MS = 5000;
const STOP_POLL_MS = 100;

function isMessage<T extends string>(msg: unknown, type: T): msg is Record<string, unknown> & { type: T } {
  return isRecord(msg) && msg.type === type;
}

/**
 * Start the background process, hand it the config and Spotify tokens over IPC (never argv/env,
 * so secrets don't show up in ps or /proc/<pid>/environ), and wait until it reports that Gather
 * is connected. Resolves with its PID.
 */
export function spawnDaemon(init: DaemonInit, logFd: number): Promise<number> {
  const child = spawn(process.execPath, programArgs(), {
    env: { ...process.env, GSS_DAEMON: "1" },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd, "ipc"],
  });

  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      clearTimeout(timer);
      child.removeAllListeners();
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail(`no connection after ${READY_TIMEOUT_MS / 1000}s`), READY_TIMEOUT_MS);

    child.on("message", (msg: unknown) => {
      if (!isMessage(msg, "ready")) return;
      clearTimeout(timer);
      child.removeAllListeners();
      child.disconnect();
      child.unref();
      if (child.pid === undefined) reject(new Error("background process has no PID"));
      else resolve(child.pid);
    });
    child.on("exit", (code, signal) => fail(`background process exited (${signal ?? `code ${code}`})`));
    child.on("error", (e) => fail(e.message));
    const message: InitMessage = { type: "init", ...init };
    child.send(message);
  });
}

/** Rebuild DaemonInit from an untrusted IPC message, keeping only the expected fields. */
function toDaemonInit(msg: Record<string, unknown>): DaemonInit {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const cfg = isRecord(msg.cfg) ? msg.cfg : {};
  const tokens = isRecord(msg.tokens) ? msg.tokens : {};
  return {
    cfg: {
      GATHER_API_KEY: str(cfg.GATHER_API_KEY),
      GATHER_SPACE_ID: str(cfg.GATHER_SPACE_ID),
      SPOTIFY_CLIENT_ID: str(cfg.SPOTIFY_CLIENT_ID),
      SPOTIFY_CLIENT_SECRET: str(cfg.SPOTIFY_CLIENT_SECRET),
    },
    tokens: {
      accessToken: str(tokens.accessToken),
      refreshToken: str(tokens.refreshToken),
      expiresAt: Number(tokens.expiresAt) || 0,
      scope: str(tokens.scope),
    },
    debug: msg.debug === true,
  };
}

/** In the daemon: wait for the startup data sent by spawnDaemon(). */
export function receiveInit(timeoutMs = INIT_TIMEOUT_MS): Promise<DaemonInit> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("did not receive startup data from the launcher")), timeoutMs);
    process.on("message", (msg: unknown) => {
      if (!isMessage(msg, "init")) return;
      clearTimeout(timer);
      resolve(toDaemonInit(msg));
    });
  });
}

/** In the daemon: tell the launcher we're up. */
export function notifyReady(): void {
  const message: ReadyMessage = { type: "ready" };
  if (process.connected && process.send) process.send(message);
}

/**
 * Stop the running instance: ask it over the control channel (clears the Gather status, works on
 * Windows too), fall back to SIGTERM. Returns false if nothing was running or it didn't stop.
 */
export async function stopDaemon(): Promise<boolean> {
  const inst = runningInstance();
  if (!inst) {
    console.log(out.dim("Not running."));
    return false;
  }
  const asked = await controlRequest(inst, "stop");
  if (!asked) {
    try {
      process.kill(inst.pid, "SIGTERM");
    } catch (e) {
      console.error(err.red(`Could not stop PID ${inst.pid}: ${errorMessage(e)}`));
      return false;
    }
  }
  for (let waited = 0; waited < STOP_TIMEOUT_MS && isAlive(inst.pid); waited += STOP_POLL_MS) {
    await sleep(STOP_POLL_MS);
  }
  if (isAlive(inst.pid)) {
    console.error(err.red(`v${inst.version} (PID ${inst.pid}) is still running.`));
    return false;
  }
  runningInstance(); // clean up the PID file if the process couldn't
  console.log(out.green(`✓ Stopped v${inst.version}`) + out.dim(` (PID ${inst.pid})`));
  return true;
}

/** --pause / --resume / --set (reload) on the running instance. */
export async function controlRunning(action: "pause" | "resume" | "reload"): Promise<"ok" | "not-running" | "failed"> {
  const inst = runningInstance();
  if (!inst) return "not-running";
  return (await controlRequest(inst, action)) ? "ok" : "failed";
}

function describeStorage(): string {
  try {
    const storage = secretStorage();
    if (!storage) return "";
    return storage === "keychain" ? keychainName() : out.yellow("config file (OS keychain unavailable)");
  } catch (e) {
    return out.yellow(`config unreadable (${errorMessage(e)})`);
  }
}

export async function printStatus(): Promise<void> {
  const inst = runningInstance();
  if (!inst) {
    console.log(out.dim("○ Not running"));
  } else {
    const response = await controlRequest(inst, "status");
    const live = isStatusPayload(response) ? response : null;
    const parts = [out.green(`● Running v${inst.version}`) + out.dim(` (PID ${inst.pid})`)];
    if (live) {
      parts.push(live.connected ? out.green("connected") : out.yellow("connecting to Gather"));
      if (live.paused) parts.push(out.yellow("paused"));
      if (live.sessionExpired) parts.push(out.red(`Spotify login expired: run ${APP_NAME}`));
      if (live.outsideWorkHours) parts.push(out.dim("outside work hours"));
      if (live.lastError && live.backoffUntil > Date.now()) parts.push(out.yellow(`retrying (${live.lastError})`));
    }
    console.log(parts.join(out.dim(" · ")));
    if (live?.lastStatus?.text) console.log(`  ${out.dim("Status: ")} ${describeStatus(live.lastStatus)}`);
  }
  console.log(`  ${out.dim("Logs:   ")} ${logPath()}`);
  const storage = describeStorage();
  if (storage) console.log(`  ${out.dim("Secrets:")} ${storage}`);
}

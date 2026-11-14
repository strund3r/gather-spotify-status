// SPDX-License-Identifier: GPL-3.0-or-later
// --doctor: non-destructive 7-point health check with fix hints.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autostartEnabled } from "./autostart";
import { out } from "./colors";
import { type Config, type ConfigInspection, inspectConfig, loadRefreshToken, saveRefreshToken } from "./config";
import { APP_NAME } from "./constants";
import { controlRequest, isStatusPayload, type StatusPayload } from "./control";
import { installPath } from "./install";
import { logPath } from "./paths";
import { type Instance, runningInstance } from "./pidfile";
import { keychainName } from "./secrets";
import type { GameLike } from "./service";
import { refreshTokens } from "./spotify";
import { findNetskopeCa, type ProbeResult, probeAll } from "./tls";
import { errorMessage, sleep } from "./util";

/** Wait long enough for a WebSocket handshake without stalling the terminal on dead credentials. */
const GATHER_CONNECT_TIMEOUT_MS = 10_000;
/** Don't hang `--doctor` exit if the Gather SDK socket refuses to close cleanly. */
const GATHER_DISCONNECT_TIMEOUT_MS = 500;
/** Pad check labels so details and hints align across all 7 rows ("Running instance" = 16 chars). */
const LABEL_WIDTH = 16;

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Actionable command or remediation shown indented beneath a warn/fail check. */
  hint?: string;
}

/** Minimal surface of `@gathertown/gather-game-client`'s global logger for capture/suppression. */
export interface GatherLoggerLike {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface GatherSdk {
  createGame: (spaceId: string, apiKey: string) => GameLike;
  gatherLogger: GatherLoggerLike;
}

export interface GatherConnectionTestOptions {
  timeoutMs?: number;
  disconnectTimeoutMs?: number;
  /** Allows unit tests to inject a fake Gather SDK instead of opening a real WebSocket. */
  loadSdk?: () => Promise<GatherSdk>;
}

/** Injectable dependencies for `runDoctor()` / `doctorCommand()` so every branch is unit-testable offline. */
export interface DoctorDeps {
  inspectConfig?: () => Promise<ConfigInspection>;
  keychainName?: () => string;
  platform?: NodeJS.Platform;
  statMode?: (p: string) => number | undefined;
  probeTls?: () => Promise<ProbeResult>;
  findNetskopeCa?: () => string | undefined;
  insecureTls?: boolean;
  loadRefreshToken?: () => Promise<string | null>;
  refreshTokens?: typeof refreshTokens;
  saveRefreshToken?: (token: string) => Promise<boolean>;
  testGather?: (spaceId: string, apiKey: string) => Promise<{ ok: boolean; error?: string }>;
  autostartEnabled?: () => boolean;
  installedBinaryPath?: () => string | undefined;
  runningInstance?: () => Instance | null;
  controlStatus?: (inst: Instance) => Promise<StatusPayload | null>;
  logFilePath?: string;
}

// ---------------------------------------------------------------------------
// Default probes & Gather connectivity check
// ---------------------------------------------------------------------------

/** Lazily load Gather SDK helpers so normal CLI commands (--help, --status) stay fast. */
export async function loadGatherSdk(): Promise<GatherSdk> {
  const [{ createGatherGame }, { logger: gatherLogger }] = await Promise.all([
    import("./service"),
    import("@gathertown/gather-game-client"),
  ]);
  return { createGame: createGatherGame, gatherLogger };
}

/** Return `st_mode` for a path, or undefined if it doesn't exist yet (so permission checks skip missing files). */
export function defaultStatMode(p: string): number | undefined {
  try {
    return fs.statSync(p).mode;
  } catch {
    return undefined;
  }
}

/** Query the running daemon's local HTTP control endpoint for its live state. */
export async function defaultControlStatus(inst: Instance): Promise<StatusPayload | null> {
  const response = await controlRequest(inst, "status");
  return isStatusPayload(response) ? response : null;
}

/** Return the per-user installed binary path if present on disk, for verifying autostart targets. */
export function existingInstalledBinary(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const p = installPath(home, platform);
  return fs.existsSync(p) ? p : undefined;
}

/**
 * Connect a temporary Gather Game instance to verify space ID and API key, then disconnect.
 * Silences the Gather SDK's global logger during the probe so internal noise doesn't pollute
 * the `--doctor` report, while capturing the last error message if the handshake stalls.
 */
export async function testGatherConnection(
  spaceId: string,
  apiKey: string,
  opts: GatherConnectionTestOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const sdk = await (opts.loadSdk ?? loadGatherSdk)();
  const timeoutMs = opts.timeoutMs ?? GATHER_CONNECT_TIMEOUT_MS;
  const disconnectTimeoutMs = opts.disconnectTimeoutMs ?? GATHER_DISCONNECT_TIMEOUT_MS;

  // Temporarily intercept Gather SDK logging; restored in finally even if connect/disconnect throws.
  const prevLogger: GatherLoggerLike = {
    log: sdk.gatherLogger.log,
    warn: sdk.gatherLogger.warn,
    error: sdk.gatherLogger.error,
  };
  let lastLoggedError: string | undefined;
  sdk.gatherLogger.log = () => {};
  sdk.gatherLogger.warn = () => {};
  sdk.gatherLogger.error = (msg: string) => {
    lastLoggedError = String(msg);
  };

  let game: GameLike | undefined;
  try {
    game = sdk.createGame(spaceId, apiKey);
    const active = game;
    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false;
      const done = (result: { ok: boolean; error?: string }) => {
        if (settled) return; // guard against both timeout firing near connect and duplicate SDK events
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        done({ ok: false, error: lastLoggedError ?? `timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      active.subscribeToConnection((connected) => {
        if (connected) done({ ok: true });
      });
      active.connect();
    });
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  } finally {
    if (game) {
      try {
        await Promise.race([game.disconnect(), sleep(disconnectTimeoutMs)]);
      } catch {
        // ignore cleanup errors on failed socket
      }
    }
    sdk.gatherLogger.log = prevLogger.log;
    sdk.gatherLogger.warn = prevLogger.warn;
    sdk.gatherLogger.error = prevLogger.error;
  }
}

// ---------------------------------------------------------------------------
// Individual health checks
// ---------------------------------------------------------------------------

/** Check config readability, required keys, and POSIX directory/file permissions (non-destructively). */
function checkConfigResult(
  info: ConfigInspection | undefined,
  configErr: string | undefined,
  platform: NodeJS.Platform,
  statMode: (p: string) => number | undefined,
): CheckResult {
  const name = "Config";
  if (configErr || !info) {
    return {
      name,
      status: "fail",
      detail: configErr ?? "could not read config",
      hint: `Run ${APP_NAME} --reset to recreate it`,
    };
  }
  if (info.missing.length > 0) {
    const location = info.exists ? info.file : `no config file at ${info.file}`;
    return {
      name,
      status: "fail",
      detail: `missing ${info.missing.join(", ")} (${location})`,
      hint: `Run ${APP_NAME} --setup (or ${APP_NAME} --set-config KEY=VALUE)`,
    };
  }
  if (platform !== "win32" && info.exists) {
    // Secrets (or fallback config) shouldn't be group/world-accessible (0700 dir / 0600 file on POSIX).
    const loose = [path.dirname(info.file), info.file].filter((p) => {
      const mode = statMode(p);
      return mode !== undefined && (mode & 0o077) !== 0;
    });
    if (loose.length > 0) {
      return {
        name,
        status: "warn",
        detail: `loose permissions on ${loose.join(", ")}`,
        hint: `Run ${APP_NAME} once (or chmod 700/600) to tighten permissions`,
      };
    }
  }
  const source = info.exists ? info.file : "using environment variables";
  const envNote = info.exists && info.fromEnv.length > 0 ? ` (from env: ${info.fromEnv.join(", ")})` : "";
  return { name, status: "ok", detail: `${source}${envNote}` };
}

/** Check whether secrets are kept in the OS keychain rather than plaintext in config.json. */
function checkKeychainResult(
  info: ConfigInspection | undefined,
  configErr: string | undefined,
  keychain: string,
): CheckResult {
  const name = "Keychain";
  if (configErr || !info) {
    return { name, status: "warn", detail: "skipped (fix config first)" };
  }
  // All 4 values supplied via env vars means nothing is written to disk or keychain by design.
  if (!info.exists && info.fromEnv.length === 4) {
    return { name, status: "ok", detail: "not needed (all credentials from environment variables)" };
  }
  if (info.storage === "file") {
    return {
      name,
      status: "warn",
      detail: `secrets stored in ${info.file} (${keychain} unavailable)`,
      hint: `Unlock ${keychain} and run ${APP_NAME} to move secrets out of config.json`,
    };
  }
  if (info.storage === "keychain") {
    return { name, status: "ok", detail: keychain };
  }
  return {
    name,
    status: "warn",
    detail: `no saved secrets yet; run ${APP_NAME} --setup`,
  };
}

/** Probe TLS reachability to Spotify/Gather and detect corporate proxy (Netskope) cert issues. */
async function checkTlsResult(
  insecureTls: boolean,
  probeTls: () => Promise<ProbeResult>,
  detectNetskopeCa: () => string | undefined,
): Promise<CheckResult> {
  const name = "TLS";
  // Don't report TLS as "verified" if verification has already been turned off globally in env.
  if (insecureTls) {
    return {
      name,
      status: "warn",
      detail: "certificate verification is disabled (NODE_TLS_REJECT_UNAUTHORIZED=0)",
      hint: "Unset NODE_TLS_REJECT_UNAUTHORIZED and use NODE_EXTRA_CA_CERTS if behind a proxy",
    };
  }
  const probe = await probeTls();
  if (probe.ok) {
    return { name, status: "ok", detail: "HTTPS verified to Spotify and Gather" };
  }
  if (!probe.tls) {
    return {
      name,
      status: "fail",
      detail: `${probe.url} (${probe.code}: ${probe.message})`,
      hint: "Check your internet connection or firewall",
    };
  }
  const ca = detectNetskopeCa();
  return {
    name,
    status: "fail",
    detail: `${probe.url} (${probe.code})`,
    hint: ca
      ? `Netskope CA detected at ${ca}. Set NODE_EXTRA_CA_CERTS="${ca}" or pass --insecure`
      : `Set NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem or run ${APP_NAME} --insecure`,
  };
}

/** Verify the saved Spotify refresh token by exchanging it for a fresh access token. */
async function checkSpotifyResult(
  values: Partial<Config> | undefined,
  loadToken: () => Promise<string | null>,
  doRefresh: typeof refreshTokens,
  saveToken: (token: string) => Promise<boolean>,
): Promise<CheckResult> {
  const name = "Spotify login";
  // Only Spotify client credentials are needed for the token endpoint, even if Gather keys are missing.
  if (!values?.SPOTIFY_CLIENT_ID || !values?.SPOTIFY_CLIENT_SECRET) {
    return { name, status: "warn", detail: "skipped (missing Spotify credentials)" };
  }
  const refreshToken = await loadToken();
  if (!refreshToken) {
    return {
      name,
      status: "fail",
      detail: "no saved Spotify login",
      hint: `Run ${APP_NAME} to log in via your browser`,
    };
  }
  const cfg: Config = {
    GATHER_API_KEY: values.GATHER_API_KEY ?? "",
    GATHER_SPACE_ID: values.GATHER_SPACE_ID ?? "",
    SPOTIFY_CLIENT_ID: values.SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET: values.SPOTIFY_CLIENT_SECRET,
  };
  const refreshed = await doRefresh(cfg, refreshToken);
  if (refreshed.ok) {
    // Persist immediately in case Spotify rotated the refresh token and invalidated the old one.
    await saveToken(refreshed.tokens.refreshToken);
    return { name, status: "ok", detail: "saved login works (token refresh succeeded)" };
  }
  if (refreshed.revoked) {
    return {
      name,
      status: "fail",
      detail: `saved login expired or revoked (${refreshed.message})`,
      hint: `Run ${APP_NAME} to log in again`,
    };
  }
  return {
    name,
    status: "fail",
    detail: `token refresh failed (${refreshed.message})`,
    hint: `Check your network connection and Spotify credentials (${APP_NAME} --setup)`,
  };
}

/** Test connecting to the configured Gather space, independently of Spotify credentials. */
async function checkGatherResult(
  values: Partial<Config> | undefined,
  testGather: (spaceId: string, apiKey: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<CheckResult> {
  const name = "Gather";
  if (!values?.GATHER_SPACE_ID || !values?.GATHER_API_KEY) {
    return { name, status: "warn", detail: "skipped (missing Gather credentials)" };
  }
  const res = await testGather(values.GATHER_SPACE_ID, values.GATHER_API_KEY);
  if (res.ok) {
    return { name, status: "ok", detail: `connected to ${values.GATHER_SPACE_ID}` };
  }
  return {
    name,
    status: "fail",
    detail: res.error ?? "could not connect to Gather",
    hint: `Check GATHER_SPACE_ID and GATHER_API_KEY (${APP_NAME} --setup)`,
  };
}

/** Report whether login autostart is configured and show the installed target binary path if present. */
function checkAutostartResult(isAutostart: () => boolean, installedBinPath: () => string | undefined): CheckResult {
  const name = "Start at login";
  if (!isAutostart()) {
    return { name, status: "ok", detail: `off (enable with: ${APP_NAME} --autostart on)` };
  }
  const installed = installedBinPath();
  return {
    name,
    status: "ok",
    detail: installed ? `on (${installed})` : "on",
  };
}

/** Inspect any currently running background instance over the local HTTP control channel. */
async function checkRunningResult(
  getRunning: () => Instance | null,
  getControlStatus: (inst: Instance) => Promise<StatusPayload | null>,
  logFile: string,
): Promise<CheckResult> {
  const name = "Running instance";
  const inst = getRunning();
  if (!inst) {
    return { name, status: "ok", detail: "not running" };
  }
  const live = await getControlStatus(inst);
  if (!live) {
    return {
      name,
      status: "warn",
      detail: `v${inst.version} (PID ${inst.pid}) did not respond`,
      hint: `Restart with ${APP_NAME} --stop && ${APP_NAME}`,
    };
  }
  if (live.sessionExpired) {
    return {
      name,
      status: "fail",
      detail: `v${inst.version} (PID ${inst.pid}) — Spotify login expired`,
      hint: `Run ${APP_NAME} --stop && ${APP_NAME} to log in again`,
    };
  }
  if (live.lastError) {
    return {
      name,
      status: "warn",
      detail: `v${inst.version} (PID ${inst.pid}) — last error: ${live.lastError}`,
      hint: `See ${logFile} or run ${APP_NAME} --logs`,
    };
  }
  const parts = [
    live.connected ? "connected" : "connecting",
    ...(live.paused ? ["paused"] : []),
    ...(live.outsideWorkHours ? ["outside work hours"] : []),
  ];
  return { name, status: "ok", detail: `v${inst.version} (PID ${inst.pid}) (${parts.join(", ")})` };
}

// ---------------------------------------------------------------------------
// Orchestration & report formatting
// ---------------------------------------------------------------------------

/** Run all 7 non-destructive diagnostic checks and return their structured results. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<CheckResult[]> {
  const inspect = deps.inspectConfig ?? inspectConfig;
  const getKeychainName = deps.keychainName ?? keychainName;
  const platform = deps.platform ?? process.platform;
  const statMode = deps.statMode ?? defaultStatMode;
  const probeTls = deps.probeTls ?? probeAll;
  const detectNetskopeCa = deps.findNetskopeCa ?? findNetskopeCa;
  const insecureTls = deps.insecureTls ?? process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
  const loadToken = deps.loadRefreshToken ?? loadRefreshToken;
  const doRefresh = deps.refreshTokens ?? refreshTokens;
  const saveToken = deps.saveRefreshToken ?? saveRefreshToken;
  const testGather = deps.testGather ?? testGatherConnection;
  const isAutostart = deps.autostartEnabled ?? autostartEnabled;
  const installedBinPath = deps.installedBinaryPath ?? existingInstalledBinary;
  const getRunning = deps.runningInstance ?? runningInstance;
  const getControlStatus = deps.controlStatus ?? defaultControlStatus;
  const logFile = deps.logFilePath ?? logPath();

  let info: ConfigInspection | undefined;
  let configErr: string | undefined;
  try {
    info = await inspect();
  } catch (e) {
    configErr = errorMessage(e);
  }

  const values = info?.values;
  return [
    checkConfigResult(info, configErr, platform, statMode),
    checkKeychainResult(info, configErr, getKeychainName()),
    await checkTlsResult(insecureTls, probeTls, detectNetskopeCa),
    await checkSpotifyResult(values, loadToken, doRefresh, saveToken),
    await checkGatherResult(values, testGather),
    checkAutostartResult(isAutostart, installedBinPath),
    await checkRunningResult(getRunning, getControlStatus, logFile),
  ];
}

function formatIcon(status: CheckStatus): string {
  if (status === "ok") return out.green("✓");
  if (status === "warn") return out.yellow("!");
  return out.red("✗");
}

/** Run `--doctor`, print the diagnostic report, and return true when all required checks pass. */
export async function doctorCommand(deps: DoctorDeps = {}): Promise<boolean> {
  console.log(`${out.bold(`Checking ${APP_NAME} setup...`)}\n`);
  const results = await runDoctor(deps);
  for (const r of results) {
    console.log(`${formatIcon(r.status)} ${out.bold(r.name.padEnd(LABEL_WIDTH))}  ${r.detail}`);
    if (r.hint) console.log(`  ${"".padEnd(LABEL_WIDTH)}  ${out.dim(`Fix: ${r.hint}`)}`);
  }
  console.log();
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  if (fails > 0) {
    console.log(
      out.red(`${fails} check${fails === 1 ? "" : "s"} failed.`) +
        out.dim(` Fix the items above and run ${APP_NAME} --doctor again.`),
    );
    return false;
  }
  if (warns > 0) {
    console.log(out.yellow(`All required checks passed (${warns} warning${warns === 1 ? "" : "s"}).`));
    return true;
  }
  console.log(out.green("All checks passed."));
  return true;
}

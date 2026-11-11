// SPDX-License-Identifier: GPL-3.0-or-later
// The running service (background process or --foreground): Gather connection, Spotify poller,
// token refresh + persistence, control channel, graceful shutdown.
// The only module that loads the Gather SDK; index.ts imports it lazily.
import { Game, logger as gatherLogger } from "@gathertown/gather-game-client";
import { type Config, loadSettings, saveRefreshToken } from "./config";
import { startControlServer } from "./control";
import { logLine } from "./logfile";
import { configureLogger, logger } from "./logger";
import { removePidFile, writePidFile } from "./pidfile";
import { Poller } from "./poller";
import type { Settings } from "./settings";
import { fetchPlayback, PLAYBACK_STATE_SCOPE, TokenManager, type TokenSet } from "./spotify";
import { CLEAR, type GatherStatus } from "./status";
import { errorMessage, sleep } from "./util";
import { VERSION } from "./version";

/** Give the "clear status" actions time to reach Gather before disconnecting. */
const SHUTDOWN_FLUSH_MS = 500;
/** Gather SDK messages can be huge (whole state dumps); cut them in the log. */
const GATHER_LOG_MAX_CHARS = 1000;

export interface ServiceOptions {
  debug: boolean;
  /** Log file for the Gather SDK's own messages ("[warn from gs] ...", "connecting to ..."). */
  logFd: number;
  /** Called once when Gather first reports connected. */
  onReady?: () => void;
  /** Called on every Gather connection change (foreground prints it nicely). */
  onConnection?: (connected: boolean) => void;
}

export interface Service {
  /** Clear the Gather status, disconnect, remove the PID file and exit with `exitCode`. */
  shutdown(reason: string, exitCode?: number): Promise<void>;
}

/** Send the Gather SDK's own messages to the log file only, never the terminal. */
function patchGatherLogger(fd: number): void {
  for (const level of ["log", "warn", "error"] as const) {
    gatherLogger[level] = (message: string) =>
      logLine(fd, `[gather ${level}] ${String(message).slice(0, GATHER_LOG_MAX_CHARS)}`);
  }
}

function setGatherStatus(game: Game, status: GatherStatus): void {
  game.sendAction({ $case: "setEmojiStatus", setEmojiStatus: { emojiStatus: status.emoji } });
  game.sendAction({ $case: "setTextStatus", setTextStatus: { textStatus: status.text } });
}

export async function runService(cfg: Config, tokens: TokenSet, opts: ServiceOptions): Promise<Service> {
  if (typeof globalThis.WebSocket === "undefined") {
    // The Gather SDK needs a browser-style WebSocket (built into Bun).
    throw new Error("No global WebSocket available: run the compiled binary or `bun src/index.ts`.");
  }
  patchGatherLogger(opts.logFd);

  let settings: Settings = loadSettings();
  configureLogger({ debug: () => opts.debug || settings.debug });

  const tokenManager = new TokenManager(cfg, tokens, {
    log: logger.info,
    onTokens: (t) => {
      saveRefreshToken(t.refreshToken)
        .then((ok) => {
          if (!ok)
            logger.warn("Could not save the refreshed Spotify login; the next start may ask you to log in again.");
        })
        .catch((e: unknown) => logger.warn(`Could not save the refreshed Spotify login: ${errorMessage(e)}`));
    },
  });

  const game = new Game(cfg.GATHER_SPACE_ID, () => Promise.resolve({ apiKey: cfg.GATHER_API_KEY }));
  let connected = false;
  let ready = false;

  const poller = new Poller({
    getToken: () => tokenManager.getValidToken(),
    forceRefresh: () => tokenManager.forceRefresh(),
    fetch: fetchPlayback,
    send: (status) => setGatherStatus(game, status),
    settings: () => settings,
    canUsePlayer: () => tokenManager.hasScope(PLAYBACK_STATE_SCOPE),
    now: () => Date.now(),
    log: logger.info,
    debug: logger.debug,
  });

  game.subscribeToConnection((isConnected) => {
    const wasConnected = connected;
    connected = isConnected;
    if (opts.onConnection) opts.onConnection(isConnected);
    else logger.info(isConnected ? "Connected to Gather." : "Disconnected from Gather; reconnecting...");
    if (isConnected) {
      if (!ready) {
        ready = true;
        poller.start();
        opts.onReady?.();
      } else if (!wasConnected) {
        logger.info("Reconnected to Gather; resending status.");
        poller.resendSoon();
      }
    }
  });
  game.connect();

  let stopping = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`${reason}; clearing Gather status and exiting.`);
    poller.stop();
    tokenManager.stop();
    try {
      setGatherStatus(game, CLEAR);
      await sleep(SHUTDOWN_FLUSH_MS);
      await Promise.race([game.disconnect(), sleep(SHUTDOWN_FLUSH_MS)]); // don't hang on a dead socket
    } catch (e) {
      logger.debug(`error while disconnecting: ${errorMessage(e)}`);
    }
    control.close();
    removePidFile();
    process.exit(exitCode); // the service owns the process: nothing else to unwind
  };

  const control = await startControlServer({
    stop: () => shutdown("Stop requested"),
    pause: () => {
      poller.pause();
      logger.info("Paused; status cleared.");
    },
    resume: () => {
      poller.resume();
      logger.info("Resumed.");
    },
    reload: () => {
      settings = loadSettings();
      logger.info("Settings reloaded.");
      poller.resendSoon();
    },
    status: () => ({
      version: VERSION,
      connected,
      paused: poller.state.paused,
      sessionExpired: poller.state.sessionExpired,
      outsideWorkHours: poller.state.outsideWorkHours,
      lastStatus: poller.state.lastStatus ?? null,
      lastError: poller.state.lastError ?? null,
      backoffUntil: poller.state.backoffUntil,
    }),
  });
  writePidFile({ port: control.port, token: control.token });
  process.on("exit", () => removePidFile());

  process.on("SIGTERM", () => void shutdown("Received SIGTERM"));
  process.on("SIGINT", () => void shutdown("Received SIGINT"));
  logger.debug(`service v${VERSION} started; control port ${control.port}`);
  return { shutdown };
}

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger as gatherLogger } from "@gathertown/gather-game-client";
import { type Config, saveSetting } from "../src/config";
import { controlRequest, isStatusPayload } from "../src/control";
import { configPath, pidPath } from "../src/paths";
import { readPidFile } from "../src/pidfile";
import { GATHER_SUBSCRIPTIONS, type GameLike, runService, type Service } from "../src/service";
import { SCOPES, type TokenSet } from "../src/spotify";
import { sleep } from "../src/util";

type GameAction = Parameters<GameLike["sendAction"]>[0];
type SentStatusAction = { kind: "emoji"; value: string | undefined } | { kind: "text"; value: string | undefined };

const savedXdg = process.env.XDG_CONFIG_HOME;
const savedGatherLogger = {
  log: gatherLogger.log,
  warn: gatherLogger.warn,
  error: gatherLogger.error,
};

let base: string;
let logFd: number;
let activeService: Service | undefined;

const cfg: Config = {
  GATHER_API_KEY: "test-gather-key",
  GATHER_SPACE_ID: "test-space/Room",
  SPOTIFY_CLIENT_ID: "test-client-id",
  SPOTIFY_CLIENT_SECRET: "test-client-secret",
};

const playingTrack = {
  is_playing: true,
  currently_playing_type: "track",
  item: { name: "Hierarchy", artists: [{ name: "Taake" }] },
};

function validTokens(): TokenSet {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    scope: SCOPES,
  };
}

function createFakeGame() {
  let onConnection: ((connected: boolean) => void) | undefined;
  const actions: GameAction[] = [];
  let connectCalls = 0;
  let disconnectCalls = 0;

  const game: GameLike = {
    connect() {
      connectCalls++;
    },
    async disconnect() {
      disconnectCalls++;
    },
    subscribeToConnection(cb) {
      onConnection = cb;
    },
    sendAction(action) {
      actions.push(action);
    },
  };

  return {
    game,
    actions,
    get connectCalls() {
      return connectCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    emitConnection(connected: boolean) {
      onConnection?.(connected);
    },
  };
}

function statusActions(actions: GameAction[]): SentStatusAction[] {
  const out: SentStatusAction[] = [];
  for (const action of actions) {
    if (action.$case === "setEmojiStatus") out.push({ kind: "emoji", value: action.setEmojiStatus.emojiStatus });
    else if (action.$case === "setTextStatus") out.push({ kind: "text", value: action.setTextStatus.textStatus });
  }
  return out;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    await sleep(5);
  }
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gss-service-"));
  process.env.XDG_CONFIG_HOME = base;
  logFd = fs.openSync(path.join(base, "service.log"), "a");
});

afterEach(async () => {
  if (activeService) {
    await activeService.shutdown("test cleanup", 0);
    activeService = undefined;
  }
  fs.rmSync(pidPath(), { force: true });
  fs.rmSync(configPath(), { force: true });
});

afterAll(() => {
  gatherLogger.log = savedGatherLogger.log;
  gatherLogger.warn = savedGatherLogger.warn;
  gatherLogger.error = savedGatherLogger.error;
  fs.closeSync(logFd);
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("service integration", () => {
  test("GATHER_SUBSCRIPTIONS includes only minimal connection diagnostic events", () => {
    expect(GATHER_SUBSCRIPTIONS).toEqual({
      info: true,
      warn: true,
      error: true,
      subscriptionsUpdated: true,
    });
  });

  test("connects, sends status, resends on reconnect, and shuts down cleanly", async () => {
    const fakeGame = createFakeGame();
    const connections: boolean[] = [];
    let readyCount = 0;
    let exitCode: number | undefined;

    const service = await runService(cfg, validTokens(), {
      debug: false,
      logFd,
      flushMs: 5,
      createGame: () => fakeGame.game,
      fetch: async () => ({ status: 200, data: playingTrack }),
      onReady: () => readyCount++,
      onConnection: (c) => connections.push(c),
      exit: (code) => {
        exitCode = code;
      },
    });
    activeService = service;

    expect(fakeGame.connectCalls).toBe(1);
    expect(readPidFile()?.pid).toBe(process.pid);

    fakeGame.emitConnection(true);
    expect(readyCount).toBe(1);
    expect(connections).toEqual([true]);

    await waitFor(() => statusActions(fakeGame.actions).length >= 2);
    expect(statusActions(fakeGame.actions).slice(0, 2)).toEqual([
      { kind: "emoji", value: "🎶" },
      { kind: "text", value: "Taake ∙ Hierarchy (Spotify)" },
    ]);

    fakeGame.emitConnection(false);
    fakeGame.emitConnection(true);
    expect(readyCount).toBe(1);
    expect(connections).toEqual([true, false, true]);

    await waitFor(() => statusActions(fakeGame.actions).length >= 4);
    expect(statusActions(fakeGame.actions).slice(2, 4)).toEqual([
      { kind: "emoji", value: "🎶" },
      { kind: "text", value: "Taake ∙ Hierarchy (Spotify)" },
    ]);

    await service.shutdown("test", 0);
    activeService = undefined;

    expect(fakeGame.disconnectCalls).toBe(1);
    expect(fs.existsSync(pidPath())).toBe(false);
    expect(exitCode).toBe(0);
    expect(statusActions(fakeGame.actions).slice(-2)).toEqual([
      { kind: "emoji", value: "" },
      { kind: "text", value: "" },
    ]);
  });

  test("control server handles status, pause, resume, reload, and stop", async () => {
    const fakeGame = createFakeGame();
    let resolveExit: (code: number) => void = () => {};
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const service = await runService(cfg, validTokens(), {
      debug: false,
      logFd,
      flushMs: 5,
      createGame: () => fakeGame.game,
      fetch: async () => ({ status: 200, data: playingTrack }),
      exit: (code) => resolveExit(code),
    });
    activeService = service;

    fakeGame.emitConnection(true);
    await waitFor(() => statusActions(fakeGame.actions).length >= 2);

    const inst = readPidFile();
    expect(inst?.port).toBeGreaterThan(0);
    expect(inst?.token).toBeTruthy();
    if (!inst) throw new Error("expected PID file to exist");

    const initialStatus = await controlRequest(inst, "status");
    expect(isStatusPayload(initialStatus)).toBe(true);
    if (isStatusPayload(initialStatus)) {
      expect(initialStatus.connected).toBe(true);
      expect(initialStatus.paused).toBe(false);
      expect(initialStatus.lastStatus).toEqual({ emoji: "🎶", text: "Taake ∙ Hierarchy (Spotify)" });
    }

    expect(await controlRequest(inst, "pause")).toEqual({ ok: true });
    expect(statusActions(fakeGame.actions).slice(2, 4)).toEqual([
      { kind: "emoji", value: "" },
      { kind: "text", value: "" },
    ]);
    const pausedStatus = await controlRequest(inst, "status");
    expect(isStatusPayload(pausedStatus) && pausedStatus.paused).toBe(true);

    expect(await controlRequest(inst, "resume")).toEqual({ ok: true });
    await waitFor(() => statusActions(fakeGame.actions).length >= 6);
    expect(statusActions(fakeGame.actions).slice(4, 6)).toEqual([
      { kind: "emoji", value: "🎶" },
      { kind: "text", value: "Taake ∙ Hierarchy (Spotify)" },
    ]);
    const resumedStatus = await controlRequest(inst, "status");
    expect(isStatusPayload(resumedStatus) && resumedStatus.paused).toBe(false);

    saveSetting("musicEmoji", "🎧");
    expect(await controlRequest(inst, "reload")).toEqual({ ok: true });
    await waitFor(() => statusActions(fakeGame.actions).length >= 8);
    expect(statusActions(fakeGame.actions).slice(6, 8)).toEqual([
      { kind: "emoji", value: "🎧" },
      { kind: "text", value: "Taake ∙ Hierarchy (Spotify)" },
    ]);

    expect(await controlRequest(inst, "stop")).toEqual({ ok: true });
    const exitCode = await exitPromise;
    activeService = undefined;

    expect(exitCode).toBe(0);
    expect(fakeGame.disconnectCalls).toBe(1);
    expect(fs.existsSync(pidPath())).toBe(false);
    expect(statusActions(fakeGame.actions).slice(-2)).toEqual([
      { kind: "emoji", value: "" },
      { kind: "text", value: "" },
    ]);
  });
});

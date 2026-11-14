import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigInspection } from "../src/config";
import { type ControlServer, type StatusPayload, startControlServer } from "../src/control";
import {
  type CheckResult,
  type DoctorDeps,
  defaultControlStatus,
  defaultStatMode,
  doctorCommand,
  existingInstalledBinary,
  type GatherLoggerLike,
  loadGatherSdk,
  runDoctor,
  testGatherConnection,
} from "../src/doctor";
import { installPath } from "../src/install";
import type { Instance } from "../src/pidfile";
import type { GameLike } from "../src/service";
import { SCOPES, type TokenSet } from "../src/spotify";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "gss-doctor-"));
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function baseInspection(overrides: Partial<ConfigInspection> = {}): ConfigInspection {
  return {
    file: path.join(base, "config.json"),
    exists: true,
    values: {
      GATHER_API_KEY: "gk",
      GATHER_SPACE_ID: "space/Room",
      SPOTIFY_CLIENT_ID: "cid",
      SPOTIFY_CLIENT_SECRET: "cs",
    },
    missing: [],
    fromEnv: [],
    storage: "keychain",
    ...overrides,
  };
}

function validTokens(): TokenSet {
  return {
    accessToken: "at",
    refreshToken: "rt-new",
    expiresAt: Date.now() + 3_600_000,
    scope: SCOPES,
  };
}

function passingDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    inspectConfig: async () => baseInspection(),
    keychainName: () => "Test Keychain",
    platform: "linux",
    statMode: () => 0o600,
    probeTls: async () => ({ ok: true }),
    findNetskopeCa: () => undefined,
    insecureTls: false,
    loadRefreshToken: async () => "rt-saved",
    refreshTokens: async () => ({ ok: true, tokens: validTokens() }),
    saveRefreshToken: async () => true,
    testGather: async () => ({ ok: true }),
    autostartEnabled: () => true,
    installedBinaryPath: () => "/usr/local/bin/gather-spotify-status",
    runningInstance: () => null,
    controlStatus: async () => null,
    logFilePath: path.join(base, "daemon.log"),
    ...overrides,
  };
}

function statusOf(results: CheckResult[], name: string): CheckResult {
  const found = results.find((r) => r.name === name);
  if (!found) throw new Error(`missing check ${name}`);
  return found;
}

describe("doctor helpers", () => {
  test("loadGatherSdk returns createGame and gatherLogger", async () => {
    const sdk = await loadGatherSdk();
    expect(typeof sdk.createGame).toBe("function");
    expect(typeof sdk.gatherLogger.log).toBe("function");
    expect(typeof sdk.gatherLogger.warn).toBe("function");
    expect(typeof sdk.gatherLogger.error).toBe("function");
  });

  test("defaultStatMode and existingInstalledBinary inspect files safely", () => {
    const tmpFile = path.join(base, "perm.json");
    fs.writeFileSync(tmpFile, "{}");
    expect(typeof defaultStatMode(tmpFile)).toBe("number");
    expect(defaultStatMode(path.join(base, "missing.json"))).toBeUndefined();

    const emptyHome = path.join(base, "empty-home");
    expect(existingInstalledBinary(emptyHome, "linux")).toBeUndefined();

    const populatedHome = path.join(base, "populated-home");
    const binPath = installPath(populatedHome, "linux");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "");
    expect(existingInstalledBinary(populatedHome, "linux")).toBe(binPath);
  });

  test("defaultControlStatus returns payload when server responds and null otherwise", async () => {
    const payload: StatusPayload = {
      version: "1.0.0",
      connected: true,
      paused: false,
      sessionExpired: false,
      outsideWorkHours: false,
      lastStatus: null,
      lastError: null,
      backoffUntil: 0,
    };
    const server: ControlServer = await startControlServer({
      stop: () => {},
      pause: () => {},
      resume: () => {},
      reload: () => {},
      status: () => payload,
    });
    try {
      const ok = await defaultControlStatus({
        pid: process.pid,
        version: "1.0.0",
        port: server.port,
        token: server.token,
      });
      expect(ok).toEqual(payload);
      const missing = await defaultControlStatus({ pid: process.pid, version: "1.0.0" });
      expect(missing).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe("testGatherConnection", () => {
  test("connects, disconnects, silences logger, and restores original logger", async () => {
    const origLog = (_msg: string) => {};
    const origWarn = (_msg: string) => {};
    const origError = (_msg: string) => {};
    const gatherLogger: GatherLoggerLike = { log: origLog, warn: origWarn, error: origError };
    let disconnected = false;

    const fakeGame = (): GameLike => {
      let onConnection: ((c: boolean) => void) | undefined;
      return {
        connect() {
          gatherLogger.log("noise");
          gatherLogger.warn("noise");
          onConnection?.(true);
          onConnection?.(true); // second event is ignored by settled guard
        },
        async disconnect() {
          disconnected = true;
        },
        subscribeToConnection(cb) {
          onConnection = cb;
        },
        sendAction() {},
      };
    };

    const res = await testGatherConnection("space/Room", "api-key", {
      loadSdk: async () => ({ createGame: fakeGame, gatherLogger }),
      disconnectTimeoutMs: 20,
    });
    expect(res).toEqual({ ok: true });
    expect(disconnected).toBe(true);
    expect(gatherLogger.log).toBe(origLog);
    expect(gatherLogger.warn).toBe(origWarn);
    expect(gatherLogger.error).toBe(origError);
  });

  test("returns logged error on timeout, or generic timeout when nothing was logged", async () => {
    const gatherLogger: GatherLoggerLike = { log: () => {}, warn: () => {}, error: () => {} };
    const failingGame = (emitErr?: string): GameLike => ({
      connect() {
        if (emitErr) gatherLogger.error(emitErr);
      },
      async disconnect() {},
      subscribeToConnection() {},
      sendAction() {},
    });

    const withErr = await testGatherConnection("s", "k", {
      timeoutMs: 15,
      disconnectTimeoutMs: 10,
      loadSdk: async () => ({ createGame: () => failingGame("invalid API key"), gatherLogger }),
    });
    expect(withErr).toEqual({ ok: false, error: "invalid API key" });

    const noErr = await testGatherConnection("s", "k", {
      timeoutMs: 15,
      disconnectTimeoutMs: 10,
      loadSdk: async () => ({ createGame: () => failingGame(), gatherLogger }),
    });
    expect(noErr.ok).toBe(false);
    expect(noErr.error).toContain("timed out");
  });

  test("catches connect exceptions and ignores disconnect cleanup failures", async () => {
    const gatherLogger = { log: () => {}, warn: () => {}, error: () => {} };
    const throwingGame = (): GameLike => ({
      connect() {
        throw new Error("socket boom");
      },
      async disconnect() {
        throw new Error("cleanup boom");
      },
      subscribeToConnection() {},
      sendAction() {},
    });

    const res = await testGatherConnection("s", "k", {
      loadSdk: async () => ({ createGame: throwingGame, gatherLogger }),
    });
    expect(res).toEqual({ ok: false, error: "socket boom" });
  });
});

describe("runDoctor & doctorCommand", () => {
  test("all 7 checks pass cleanly", async () => {
    let savedToken = "";
    const deps = passingDeps({
      saveRefreshToken: async (t) => {
        savedToken = t;
        return true;
      },
      inspectConfig: async () => baseInspection({ fromEnv: ["GATHER_API_KEY"] }),
      runningInstance: () => ({ pid: 4242, version: "1.1.0", port: 9999, token: "t" }),
      controlStatus: async () => ({
        version: "1.1.0",
        connected: false,
        paused: true,
        sessionExpired: false,
        outsideWorkHours: true,
        lastStatus: null,
        lastError: null,
        backoffUntil: 0,
      }),
    });

    const results = await runDoctor(deps);
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(statusOf(results, "Config").detail).toContain("from env: GATHER_API_KEY");
    expect(statusOf(results, "Running instance").detail).toContain("connecting, paused, outside work hours");
    expect(savedToken).toBe("rt-new");
    expect(await doctorCommand(deps)).toBe(true);
  });

  test("handles env-only config and disabled autostart with warnings summary", async () => {
    const deps = passingDeps({
      inspectConfig: async () =>
        baseInspection({
          exists: false,
          storage: undefined,
          fromEnv: ["GATHER_API_KEY", "GATHER_SPACE_ID", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
        }),
      insecureTls: true,
      autostartEnabled: () => false,
    });

    const results = await runDoctor(deps);
    expect(statusOf(results, "Config")).toMatchObject({ status: "ok", detail: "using environment variables" });
    expect(statusOf(results, "Keychain").status).toBe("ok");
    expect(statusOf(results, "TLS").status).toBe("warn");
    expect(statusOf(results, "Start at login").detail).toContain("--autostart on");
    expect(await doctorCommand(deps)).toBe(true);
  });

  test("handles corrupt config, TLS failure (Netskope CA and generic), and skips dependent checks", async () => {
    const corrupt = passingDeps({
      inspectConfig: async () => {
        throw new Error("bad json");
      },
      probeTls: async () => ({
        ok: false,
        tls: true,
        url: "https://api.spotify.com/",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
        message: "self signed cert",
      }),
      findNetskopeCa: () => "/opt/netskope/nscacert.pem",
      installedBinaryPath: () => undefined,
    });
    const r1 = await runDoctor(corrupt);
    expect(statusOf(r1, "Config").status).toBe("fail");
    expect(statusOf(r1, "Keychain").status).toBe("warn");
    expect(statusOf(r1, "TLS").hint).toContain("/opt/netskope/nscacert.pem");
    expect(statusOf(r1, "Spotify login").status).toBe("warn");
    expect(statusOf(r1, "Gather").status).toBe("warn");
    expect(statusOf(r1, "Start at login").detail).toBe("on");
    expect(await doctorCommand(corrupt)).toBe(false);
  });

  test("covers missing config, loose POSIX permissions, file secrets, TLS network failure, and empty CA", async () => {
    const missingFromFile = passingDeps({
      inspectConfig: async () => baseInspection({ exists: false, storage: undefined, missing: ["GATHER_API_KEY"] }),
      probeTls: async () => ({
        ok: false,
        tls: true,
        url: "https://api.gather.town/",
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        message: "verify failed",
      }),
      findNetskopeCa: () => undefined,
    });
    const rMissing = await runDoctor(missingFromFile);
    expect(statusOf(rMissing, "Config").status).toBe("fail");
    expect(statusOf(rMissing, "Config").detail).toContain("no config file");
    expect(statusOf(rMissing, "Keychain").status).toBe("warn");
    expect(statusOf(rMissing, "TLS").hint).toContain("NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem");

    const missingInExisting = await runDoctor(
      passingDeps({ inspectConfig: async () => baseInspection({ exists: true, missing: ["SPOTIFY_CLIENT_ID"] }) }),
    );
    expect(statusOf(missingInExisting, "Config").detail).toContain(path.join(base, "config.json"));

    const looseAndNetFail = passingDeps({
      inspectConfig: async () => baseInspection({ storage: "file", missing: [] }),
      platform: "linux",
      statMode: () => 0o644,
      probeTls: async () => ({
        ok: false,
        tls: false,
        url: "https://api.spotify.com/",
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND",
      }),
    });
    const rLoose = await runDoctor(looseAndNetFail);
    expect(statusOf(rLoose, "Config").status).toBe("warn");
    expect(statusOf(rLoose, "Keychain").status).toBe("warn");
    expect(statusOf(rLoose, "TLS")).toMatchObject({
      status: "fail",
      hint: "Check your internet connection or firewall",
    });

    // Tight check skipped on win32; two warnings printed by doctorCommand
    const twoWarns = passingDeps({
      platform: "win32",
      statMode: () => 0o644,
      inspectConfig: async () => baseInspection({ storage: "file" }),
      insecureTls: true,
    });
    expect(statusOf(await runDoctor(twoWarns), "Config").status).toBe("ok");
    expect(await doctorCommand(twoWarns)).toBe(true);
  });

  test("covers Spotify failures, Gather failures, and running instance states", async () => {
    const inst: Instance = { pid: 123, version: "1.0.0", port: 5000, token: "tok" };

    const missingToken = await runDoctor(
      passingDeps({
        loadRefreshToken: async () => null,
        testGather: async () => ({ ok: false, error: "bad auth" }),
        runningInstance: () => inst,
        controlStatus: async () => null,
      }),
    );
    expect(statusOf(missingToken, "Spotify login")).toMatchObject({
      status: "fail",
      detail: "no saved Spotify login",
    });
    expect(statusOf(missingToken, "Gather")).toMatchObject({ status: "fail", detail: "bad auth" });
    expect(statusOf(missingToken, "Running instance").status).toBe("warn");

    const revoked = await runDoctor(
      passingDeps({
        refreshTokens: async () => ({ ok: false, revoked: true, message: "invalid_grant" }),
        testGather: async () => ({ ok: false }),
        runningInstance: () => inst,
        controlStatus: async () => ({
          version: "1.0.0",
          connected: true,
          paused: false,
          sessionExpired: true,
          outsideWorkHours: false,
          lastStatus: null,
          lastError: null,
          backoffUntil: 0,
        }),
      }),
    );
    expect(statusOf(revoked, "Spotify login").detail).toContain("expired or revoked");
    expect(statusOf(revoked, "Gather").detail).toBe("could not connect to Gather");
    expect(statusOf(revoked, "Running instance").status).toBe("fail");

    const transient = passingDeps({
      refreshTokens: async () => ({ ok: false, revoked: false, message: "timeout" }),
      runningInstance: () => inst,
      controlStatus: async () => ({
        version: "1.0.0",
        connected: true,
        paused: false,
        sessionExpired: false,
        outsideWorkHours: false,
        lastStatus: null,
        lastError: "rate limited",
        backoffUntil: 0,
      }),
    });
    const rTransient = await runDoctor(transient);
    expect(statusOf(rTransient, "Spotify login").detail).toContain("token refresh failed");
    expect(statusOf(rTransient, "Running instance").status).toBe("warn");
    expect(await doctorCommand(transient)).toBe(false);
  });
});

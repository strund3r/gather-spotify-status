import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fake keychain: never touch the real one in tests.
const store = new Map<string, string>();
let keychainWorks = true;
mock.module("../src/secrets", () => ({
  keychainName: () => "Test Keychain",
  getSecret: async (name: string) => (keychainWorks ? (store.get(name) ?? null) : null),
  storeSecret: async (name: string, value: string) => {
    if (!keychainWorks) return false;
    store.set(name, value);
    return true;
  },
  deleteSecret: async (name: string) => {
    store.delete(name);
  },
}));

const config = await import("../src/config");

const ENV_KEYS = ["GATHER_API_KEY", "GATHER_SPACE_ID", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"];
const savedEnv = Object.fromEntries(["XDG_CONFIG_HOME", ...ENV_KEYS].map((k) => [k, process.env[k]]));
let base: string;
const file = () => path.join(base, "gather-spotify-status", "config.json");
const readFile = () => JSON.parse(fs.readFileSync(file(), "utf8"));
const writeFile = (obj: object, mode = 0o600) => {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(obj));
  fs.chmodSync(file(), mode);
};
const OLD = { GATHER_API_KEY: "gk", GATHER_SPACE_ID: "sp/Room", SPOTIFY_CLIENT_ID: "cid", SPOTIFY_CLIENT_SECRET: "cs" };

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gss-cfg-"));
  process.env.XDG_CONFIG_HOME = base;
  for (const k of ENV_KEYS) delete process.env[k];
  store.clear();
  keychainWorks = true;
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadConfig", () => {
  test("migrates plaintext secrets to the keychain; file keeps only non-secrets", async () => {
    writeFile(OLD);
    const cfg = await config.loadConfig();
    expect(cfg).toEqual(OLD);
    expect(store.get("GATHER_API_KEY")).toBe("gk");
    expect(store.get("SPOTIFY_CLIENT_SECRET")).toBe("cs");
    const f = readFile();
    expect(f).toEqual({ GATHER_SPACE_ID: "sp/Room", SPOTIFY_CLIENT_ID: "cid", secretStorage: "keychain" });
  });

  test("second load reads secrets from the keychain", async () => {
    writeFile(OLD);
    await config.loadConfig();
    expect(await config.loadConfig()).toEqual(OLD);
  });

  test("no keychain: secrets stay in the file", async () => {
    keychainWorks = false;
    writeFile(OLD);
    expect(await config.loadConfig()).toEqual(OLD);
    expect(readFile().GATHER_API_KEY).toBe("gk");
  });

  test("env vars win and are never stored", async () => {
    writeFile({ GATHER_SPACE_ID: "sp/Room", SPOTIFY_CLIENT_ID: "cid", secretStorage: "keychain" });
    process.env.GATHER_API_KEY = "envKey";
    process.env.SPOTIFY_CLIENT_SECRET = "envSecret";
    const cfg = await config.loadConfig();
    expect(cfg.GATHER_API_KEY).toBe("envKey");
    expect(store.size).toBe(0);
    expect(JSON.stringify(readFile())).not.toContain("env");
  });

  test("tightens loose permissions", async () => {
    if (process.platform === "win32") return;
    writeFile(OLD, 0o644);
    fs.chmodSync(path.dirname(file()), 0o755);
    await config.loadConfig();
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file())).mode & 0o777).toBe(0o700);
  });

  test("keeps the settings section when rewriting", async () => {
    writeFile({ ...OLD, settings: { maxLength: 42 } });
    await config.loadConfig();
    expect(readFile().settings).toEqual({ maxLength: 42 });
    expect(config.loadSettings().maxLength).toBe(42);
  });
});

describe("settings + refresh token", () => {
  test("saveSetting keeps other fields", async () => {
    writeFile(OLD);
    await config.loadConfig();
    config.saveSetting("statusFormat", "{track}");
    expect(readFile().GATHER_SPACE_ID).toBe("sp/Room");
    expect(config.loadSettings().statusFormat).toBe("{track}");
  });

  test("refresh token: keychain mode", async () => {
    writeFile(OLD);
    await config.loadConfig();
    expect(await config.saveRefreshToken("rt1")).toBe(true);
    expect(store.get("SPOTIFY_REFRESH_TOKEN")).toBe("rt1");
    expect(await config.loadRefreshToken()).toBe("rt1");
    expect(readFile().SPOTIFY_REFRESH_TOKEN).toBeUndefined();
    await config.deleteRefreshToken();
    expect(await config.loadRefreshToken()).toBeNull();
  });

  test("refresh token: file mode, then migrated when the keychain appears", async () => {
    keychainWorks = false;
    writeFile(OLD);
    await config.loadConfig();
    expect(await config.saveRefreshToken("rt-file")).toBe(true);
    expect(readFile().SPOTIFY_REFRESH_TOKEN).toBe("rt-file");
    keychainWorks = true;
    await config.loadConfig(); // migration
    expect(store.get("SPOTIFY_REFRESH_TOKEN")).toBe("rt-file");
    expect(readFile().SPOTIFY_REFRESH_TOKEN).toBeUndefined();
  });

  test("autostart question is remembered, other fields kept", async () => {
    writeFile(OLD);
    await config.loadConfig();
    expect(config.autostartAsked()).toBe(false);
    config.markAutostartAsked();
    expect(config.autostartAsked()).toBe(true);
    expect(readFile().GATHER_SPACE_ID).toBe("sp/Room");
    await config.loadConfig(); // rewriting the config keeps the flag
    expect(config.autostartAsked()).toBe(true);
  });

  test("resetConfig removes keychain entries and the file", async () => {
    writeFile(OLD);
    await config.loadConfig();
    await config.saveRefreshToken("rt1");
    await config.resetConfig();
    expect(store.size).toBe(0);
    expect(fs.existsSync(file())).toBe(false);
  });
});

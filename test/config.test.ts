import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserError } from "../src/errors";

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

  test("missing config throws UserError in non-TTY", async () => {
    await expect(config.loadConfig(async () => "", false)).rejects.toThrow(/Missing configuration/);
  });

  test("first-time setup prompts for missing fields and skips storing env secrets", async () => {
    process.env.GATHER_API_KEY = "env-gk";
    const answers = ["sp/Prompted", "cid-p", "cs-p"];
    const cfg = await config.loadConfig(async () => answers.shift() ?? "", true);
    expect(cfg).toEqual({
      GATHER_API_KEY: "env-gk",
      GATHER_SPACE_ID: "sp/Prompted",
      SPOTIFY_CLIENT_ID: "cid-p",
      SPOTIFY_CLIENT_SECRET: "cs-p",
    });
    expect(store.get("GATHER_API_KEY")).toBeUndefined();
    expect(store.get("SPOTIFY_CLIENT_SECRET")).toBe("cs-p");
    expect(readFile()).toEqual({
      GATHER_SPACE_ID: "sp/Prompted",
      SPOTIFY_CLIENT_ID: "cid-p",
      secretStorage: "keychain",
    });
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

describe("parseSetConfigArg", () => {
  test("parses KEY=VALUE and bare KEY", () => {
    expect(config.parseSetConfigArg("GATHER_API_KEY=a=b")).toEqual({ key: "GATHER_API_KEY", value: "a=b" });
    expect(config.parseSetConfigArg("  GATHER_SPACE_ID = sp/Room  ")).toEqual({
      key: "GATHER_SPACE_ID",
      value: "sp/Room",
    });
    expect(config.parseSetConfigArg("SPOTIFY_CLIENT_ID")).toEqual({ key: "SPOTIFY_CLIENT_ID" });
  });

  test("rejects unknown keys and empty values", () => {
    expect(() => config.parseSetConfigArg("UNKNOWN=1")).toThrow(/unknown config key/);
    expect(() => config.parseSetConfigArg("GATHER_API_KEY=")).toThrow(/cannot be empty/);
    expect(() => config.parseSetConfigArg("GATHER_API_KEY=   ")).toThrow(/cannot be empty/);
  });
});

describe("setConfigCommand", () => {
  const fakeAsk = (answers: string[]) => {
    const queue = [...answers];
    const asked: Array<{ question: string; secret: boolean }> = [];
    const fn = async (question: string, secret = false) => {
      asked.push({ question, secret });
      return queue.shift() ?? "";
    };
    return { fn, asked };
  };

  test("updates non-Spotify key while preserving settings and Spotify login", async () => {
    writeFile({ ...OLD, settings: { maxLength: 42 }, autostartAsked: true });
    await config.loadConfig();
    await config.saveRefreshToken("rt1");

    await config.setConfigCommand(["GATHER_API_KEY=new-gk"]);

    expect(store.get("GATHER_API_KEY")).toBe("new-gk");
    expect(store.get("SPOTIFY_REFRESH_TOKEN")).toBe("rt1");
    expect(readFile().settings).toEqual({ maxLength: 42 });
    expect(readFile().autostartAsked).toBe(true);
    expect(await config.loadConfig()).toEqual({ ...OLD, GATHER_API_KEY: "new-gk" });
  });

  test("preserves Spotify login when SPOTIFY_CLIENT_ID is set to the same value", async () => {
    writeFile(OLD);
    await config.loadConfig();
    await config.saveRefreshToken("rt1");

    await config.setConfigCommand(["SPOTIFY_CLIENT_ID=cid"]);
    expect(store.get("SPOTIFY_REFRESH_TOKEN")).toBe("rt1");
  });

  test("clears Spotify login when SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET changes", async () => {
    writeFile(OLD);
    await config.loadConfig();
    await config.saveRefreshToken("rt1");

    await config.setConfigCommand(["SPOTIFY_CLIENT_ID=new-cid"]);
    expect(readFile().SPOTIFY_CLIENT_ID).toBe("new-cid");
    expect(await config.loadRefreshToken()).toBeNull();

    await config.saveRefreshToken("rt2");
    await config.setConfigCommand(["SPOTIFY_CLIENT_SECRET=new-cs"]);
    expect(store.get("SPOTIFY_CLIENT_SECRET")).toBe("new-cs");
    expect(await config.loadRefreshToken()).toBeNull();
  });

  test("prompts via askFn when =VALUE is omitted (and re-prompts on empty)", async () => {
    writeFile(OLD);
    await config.loadConfig();
    const { fn, asked } = fakeAsk(["", "sp/New"]);

    await config.setConfigCommand(["GATHER_SPACE_ID"], fn, true);

    expect(asked).toEqual([
      { question: "  GATHER_SPACE_ID: ", secret: false },
      { question: "  GATHER_SPACE_ID: ", secret: false },
    ]);
    expect(readFile().GATHER_SPACE_ID).toBe("sp/New");
  });

  test("requires TTY when =VALUE is omitted and validates all args before saving", async () => {
    writeFile(OLD);
    await config.loadConfig();

    await expect(config.setConfigCommand(["GATHER_API_KEY"], fakeAsk([]).fn, false)).rejects.toBeInstanceOf(UserError);
    await expect(config.setConfigCommand(["GATHER_API_KEY=changed", "NOPE=1"])).rejects.toMatchObject({ exitCode: 2 });
    expect(store.get("GATHER_API_KEY")).toBe("gk");
  });

  test("works in file-fallback mode without losing refresh token on unrelated change", async () => {
    keychainWorks = false;
    writeFile(OLD);
    await config.loadConfig();
    await config.saveRefreshToken("rt-file");

    await config.setConfigCommand(["GATHER_API_KEY=file-gk2"]);
    expect(readFile().GATHER_API_KEY).toBe("file-gk2");
    expect(readFile().SPOTIFY_REFRESH_TOKEN).toBe("rt-file");
  });
});

describe("setupCommand", () => {
  test("throws in non-TTY", async () => {
    await expect(config.setupCommand(async () => "", false)).rejects.toBeInstanceOf(UserError);
  });

  test("keeps existing values on Enter, updates changed ones, and preserves settings & login", async () => {
    writeFile({ ...OLD, settings: { workHours: "Mon-Fri 09:00-18:00" } });
    await config.loadConfig();
    await config.saveRefreshToken("rt1");

    const answers = ["", "sp/Updated", "", ""];
    const cfg = await config.setupCommand(async () => answers.shift() ?? "", true);

    expect(cfg).toEqual({ ...OLD, GATHER_SPACE_ID: "sp/Updated" });
    expect(readFile().settings).toEqual({ workHours: "Mon-Fri 09:00-18:00" });
    expect(store.get("SPOTIFY_REFRESH_TOKEN")).toBe("rt1");
  });

  test("clears Spotify login when Spotify client secret changes during setup", async () => {
    writeFile(OLD);
    await config.loadConfig();
    await config.saveRefreshToken("rt1");

    const answers = ["", "", "", "new-cs"];
    const cfg = await config.setupCommand(async () => answers.shift() ?? "", true);

    expect(cfg.SPOTIFY_CLIENT_SECRET).toBe("new-cs");
    expect(await config.loadRefreshToken()).toBeNull();
  });

  test("re-prompts on empty input when no existing config exists", async () => {
    const answers = ["", "gk1", "sp/Room1", "cid1", "cs1"];
    const cfg = await config.setupCommand(async () => answers.shift() ?? "", true);

    expect(cfg).toEqual({
      GATHER_API_KEY: "gk1",
      GATHER_SPACE_ID: "sp/Room1",
      SPOTIFY_CLIENT_ID: "cid1",
      SPOTIFY_CLIENT_SECRET: "cs1",
    });
    expect(store.get("GATHER_API_KEY")).toBe("gk1");
    expect(store.get("SPOTIFY_CLIENT_SECRET")).toBe("cs1");
  });
});

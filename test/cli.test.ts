import { describe, expect, test } from "bun:test";
import { parseFlags } from "../src/cli";
import { UsageError } from "../src/errors";

describe("parseFlags", () => {
  test("no args: start with defaults", () => {
    const f = parseFlags([]);
    expect(f.info).toBeUndefined();
    expect(f.set).toEqual([]);
    expect(f.autostartRun).toBe(false);
    expect(f.logs).toBeUndefined();
  });

  test("boolean flags", () => {
    const f = parseFlags(["--reset", "--insecure", "--foreground", "--no-install", "--debug", "--logout"]);
    expect(f).toMatchObject({
      reset: true,
      insecure: true,
      foreground: true,
      noInstall: true,
      debug: true,
      logout: true,
    });
    expect(f.stop).toBe(false);
  });

  test("info flags stop parsing (even before invalid args)", () => {
    expect(parseFlags(["--help", "--bogus"]).info).toBe("help");
    expect(parseFlags(["-v"]).info).toBe("version");
    expect(parseFlags(["--config-path"]).info).toBe("config-path");
  });

  test("--autostart: bare = run mode, with on/off/status = command", () => {
    const bare = parseFlags(["--autostart"]);
    expect(bare.autostartRun).toBe(true);
    expect(bare.autostartAction).toBeUndefined();
    expect(parseFlags(["--autostart", "on"])).toMatchObject({ autostartRun: false, autostartAction: "on" });
    expect(parseFlags(["--autostart", "status"]).autostartAction).toBe("status");
    expect(parseFlags(["--autostart", "--debug"])).toMatchObject({ autostartRun: true, debug: true });
  });

  test("--logs and -n", () => {
    expect(parseFlags(["--logs"]).logs).toBe(50);
    expect(parseFlags(["--logs", "-n", "5"]).logs).toBe(5);
    expect(parseFlags(["-n", "0"]).logs).toBe(0);
    expect(() => parseFlags(["-n"])).toThrow(UsageError);
    expect(() => parseFlags(["-n", "x"])).toThrow(/number of lines/);
    expect(() => parseFlags(["-n", "-1"])).toThrow(UsageError);
  });

  test("--get with and without a key", () => {
    expect(parseFlags(["--get"]).get).toBe("all");
    expect(parseFlags(["--get", "--debug"])).toMatchObject({ get: "all", debug: true });
    expect(parseFlags(["--get", "maxLength"]).get).toBe("maxLength");
    expect(() => parseFlags(["--get", "nope"])).toThrow(/Unknown setting "nope"/);
  });

  test("--set is repeatable and keeps values starting with '-'", () => {
    expect(parseFlags(["--set", "a=1", "--set", "b=-2"]).set).toEqual(["a=1", "b=-2"]);
    expect(() => parseFlags(["--set"])).toThrow(/key=value/);
  });

  test("unknown option → UsageError with exit code 2", () => {
    try {
      parseFlags(["--wat"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect((e as UsageError).exitCode).toBe(2);
      expect((e as UsageError).message).toBe("Unknown option: --wat");
    }
  });
});

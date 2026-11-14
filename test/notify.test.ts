import { describe, expect, test } from "bun:test";
import { APP_NAME } from "../src/constants";
import { notificationCommand, runNotifyProcess, sendDesktopNotification } from "../src/notify";

describe("notificationCommand", () => {
  test("builds Linux notify-send command", () => {
    expect(notificationCommand("New update", "Run --update", "linux")).toEqual({
      cmd: "notify-send",
      args: ["--app-name", APP_NAME, "--", "New update", "Run --update"],
    });
  });

  test("builds macOS osascript command passing title and body via argv", () => {
    const spec = notificationCommand('Title "quoted"', "Body $var", "darwin");
    expect(spec?.cmd).toBe("osascript");
    expect(spec?.args.slice(-2)).toEqual(['Title "quoted"', "Body $var"]);
  });

  test("builds Windows powershell toast command with env vars", () => {
    const spec = notificationCommand("Title", "Body", "win32");
    expect(spec?.cmd).toBe("powershell.exe");
    expect(spec?.args).toContain("-NonInteractive");
    expect(spec?.env).toEqual({ GSS_NOTIFY_TITLE: "Title", GSS_NOTIFY_BODY: "Body" });
  });

  test("returns null on unsupported platform and defaults to process.platform", () => {
    expect(notificationCommand("Title", "Body", "freebsd" as NodeJS.Platform)).toBeNull();
    const current = notificationCommand("Title", "Body");
    if (process.platform === "linux" || process.platform === "darwin" || process.platform === "win32") {
      expect(current).not.toBeNull();
    }
  });
});

describe("runNotifyProcess", () => {
  test("executes a child process and returns status", () => {
    const res = runNotifyProcess(process.execPath, ["--version"], process.env);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
  });
});

describe("sendDesktopNotification", () => {
  test("returns true when runner succeeds and passes platform env on Windows", () => {
    let seenCmd = "";
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const ok = sendDesktopNotification("New v1.2.0", "Run --update", {
      platform: "win32",
      run: (cmd, _args, env) => {
        seenCmd = cmd;
        seenEnv = env;
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(seenCmd).toBe("powershell.exe");
    expect(seenEnv?.GSS_NOTIFY_TITLE).toBe("New v1.2.0");
    expect(seenEnv?.GSS_NOTIFY_BODY).toBe("Run --update");

    const okLinux = sendDesktopNotification("New v1.2.0", "Run --update", {
      platform: "linux",
      run: () => ({ status: 0 }),
    });
    expect(okLinux).toBe(true);
  });

  test("returns false on non-zero exit, spawn error, exception, or unsupported platform", () => {
    expect(
      sendDesktopNotification("T", "B", {
        platform: "linux",
        run: () => ({ status: 1 }),
      }),
    ).toBe(false);

    expect(
      sendDesktopNotification("T", "B", {
        platform: "linux",
        run: () => ({ status: 0, error: new Error("ENOENT") }),
      }),
    ).toBe(false);

    expect(
      sendDesktopNotification("T", "B", {
        platform: "darwin",
        run: () => {
          throw new Error("spawn failure");
        },
      }),
    ).toBe(false);

    expect(
      sendDesktopNotification("T", "B", {
        platform: "freebsd" as NodeJS.Platform,
        run: () => ({ status: 0 }),
      }),
    ).toBe(false);
  });
});

// --status / --stop / --pause against a fake running instance: a real child process plus an
// in-process control server, with the PID file in a temp config dir.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ControlServer, type StatusPayload, startControlServer } from "../src/control";
import { controlRunning, printStatus, stopDaemon } from "../src/daemon";
import { pidPath } from "../src/paths";
import { isAlive, writePidFile } from "../src/pidfile";

const savedXdg = process.env.XDG_CONFIG_HOME;
let base: string;
let child: ChildProcess | undefined;
let control: ControlServer | undefined;
let paused = false;

const status = (): StatusPayload => ({
  version: "9.9.9",
  connected: true,
  paused,
  sessionExpired: false,
  outsideWorkHours: false,
  lastStatus: { emoji: "🎶", text: "Artist ∙ Song (Spotify)" },
  lastError: null,
  backoffUntil: 0,
});

/** Start a long-running child (marked like our daemon) and point the PID file at it. */
async function fakeInstance(): Promise<number> {
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, GSS_DAEMON: "1" },
    stdio: "ignore",
  });
  const pid = child.pid ?? 0;
  control = await startControlServer({
    stop: () => {
      child?.kill();
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    reload: () => {},
    status,
  });
  // The PID file is written by the daemon itself (its own pid); rewrite it with the child's pid.
  writePidFile({ port: control.port, token: control.token });
  const data = JSON.parse(fs.readFileSync(pidPath(), "utf8"));
  fs.writeFileSync(pidPath(), JSON.stringify({ ...data, pid, version: "9.9.9" }));
  return pid;
}

function captureConsole() {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  return {
    lines,
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gss-daemon-"));
  process.env.XDG_CONFIG_HOME = base;
});
afterEach(() => {
  child?.kill();
  child = undefined;
  control?.close();
  control = undefined;
  paused = false;
  fs.rmSync(pidPath(), { force: true });
});
afterAll(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("daemon commands", () => {
  test("nothing running", async () => {
    const out = captureConsole();
    try {
      await printStatus();
      expect(await stopDaemon()).toBe(false);
      expect(await controlRunning("pause")).toBe("not-running");
    } finally {
      out.restore();
    }
    expect(out.lines.join("\n")).toContain("Not running");
  });

  test("status shows live info; pause goes through the control channel", async () => {
    const pid = await fakeInstance();
    expect(await controlRunning("pause")).toBe("ok");
    expect(paused).toBe(true);

    const out = captureConsole();
    try {
      await printStatus();
    } finally {
      out.restore();
    }
    const text = out.lines.join("\n");
    expect(text).toContain(`Running v9.9.9`);
    expect(text).toContain(`PID ${pid}`);
    expect(text).toContain("connected");
    expect(text).toContain("paused");
    expect(text).toContain("🎶 Artist ∙ Song (Spotify)");
  });

  test("stop asks over the control channel and waits for the exit", async () => {
    const pid = await fakeInstance();
    const out = captureConsole();
    let stopped: boolean;
    try {
      stopped = await stopDaemon();
    } finally {
      out.restore();
    }
    expect(stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect(fs.existsSync(pidPath())).toBe(false);
    expect(out.lines.join("\n")).toContain("Stopped v9.9.9");
  });

  test("an instance without a control channel is stopped with SIGTERM", async () => {
    const pid = await fakeInstance();
    fs.writeFileSync(pidPath(), JSON.stringify({ pid, version: "1.3.0" })); // PID file without a control channel
    const out = captureConsole();
    try {
      expect(await stopDaemon()).toBe(true);
    } finally {
      out.restore();
    }
    expect(isAlive(pid)).toBe(false);
  });
});

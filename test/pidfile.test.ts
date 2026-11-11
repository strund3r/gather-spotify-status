import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAlive, readPidFile, removePidFile, runningInstance, writePidFile } from "../src/pidfile";
import { VERSION } from "../src/version";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gss-pid-"));
  file = path.join(dir, "sub", "app.pid");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("PID file", () => {
  test("write/read round trip, mode 0600, private dir", () => {
    writePidFile({ port: 1234, token: "t0k" }, file);
    expect(readPidFile(file)).toEqual({ pid: process.pid, version: VERSION, port: 1234, token: "t0k" });
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  test("missing / corrupt / wrong shape → null", () => {
    expect(readPidFile(file)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(readPidFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ pid: "12" }));
    expect(readPidFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ pid: 12, port: "x" }));
    expect(readPidFile(file)).toEqual({ pid: 12, version: "?", port: undefined, token: undefined });
  });

  test("own PID is never 'the running instance', and the file is kept", () => {
    writePidFile(undefined, file);
    expect(runningInstance(file)).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });

  test("stale PID: file removed", async () => {
    const child = spawn(process.execPath, ["-e", "0"]);
    const pid = child.pid ?? 0;
    await new Promise((r) => child.on("exit", r));
    expect(isAlive(pid)).toBe(false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid, version: "1.0.0" }));
    expect(runningInstance(file)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  test("removePidFile only removes our own file", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 1, version: "1.0.0" }));
    removePidFile(file);
    expect(fs.existsSync(file)).toBe(true);
    writePidFile(undefined, file);
    removePidFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});

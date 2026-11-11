// fsutil, logfile, logs: everything in a temp dir.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, removeFile, writePrivateFile, writePrivateJson } from "../src/fsutil";
import { logLine, MAX_LOG_BYTES, openLog } from "../src/logfile";
import { lastLines, logFollower } from "../src/logs";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gss-files-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("fsutil", () => {
  test("writePrivateFile: creates dirs 0700, file 0600, no tmp left behind", () => {
    const file = path.join(dir, "a", "b", "x.json");
    writePrivateFile(file, "one");
    writePrivateFile(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["x.json"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  test("tightens an existing loose file", () => {
    if (process.platform === "win32") return;
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    writePrivateJson(file, { a: 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readJson(file)).toEqual({ a: 1 });
  });

  test("readJson: undefined for missing or invalid", () => {
    expect(readJson(path.join(dir, "missing"))).toBeUndefined();
    fs.writeFileSync(path.join(dir, "bad"), "{");
    expect(readJson(path.join(dir, "bad"))).toBeUndefined();
  });

  test("removeFile reports whether it existed", () => {
    const file = path.join(dir, "f");
    fs.writeFileSync(file, "");
    expect(removeFile(file)).toBe(true);
    expect(removeFile(file)).toBe(false);
  });
});

describe("log file", () => {
  test("appends timestamped lines with mode 0600", () => {
    const file = path.join(dir, "cfg", "app.log");
    const fd = openLog(file, path.dirname(file));
    logLine(fd, "hello");
    fs.closeSync(fd);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z hello\n$/);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("rotates to .1 when over the size limit", () => {
    const file = path.join(dir, "app.log");
    fs.writeFileSync(file, "x".repeat(MAX_LOG_BYTES + 1));
    fs.closeSync(openLog(file, dir));
    expect(fs.statSync(`${file}.1`).size).toBe(MAX_LOG_BYTES + 1);
    expect(fs.statSync(file).size).toBe(0);
  });
});

describe("--logs", () => {
  test("lastLines", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(lastLines("a\nb", 5)).toBe("a\nb");
    expect(lastLines("", 3)).toBe("");
  });

  test("follower prints appended data, survives rotation and a missing file", () => {
    const file = path.join(dir, "app.log");
    fs.writeFileSync(file, "old\n");
    const chunks: string[] = [];
    const read = logFollower(file, 4, (c) => chunks.push(c.toString()));
    read();
    expect(chunks).toEqual([]);
    fs.appendFileSync(file, "new 1\n");
    read();
    fs.renameSync(file, `${file}.1`); // rotation: file missing for a moment
    read();
    fs.writeFileSync(file, "after\n");
    read();
    expect(chunks).toEqual(["new 1\n", "after\n"]);
  });
});

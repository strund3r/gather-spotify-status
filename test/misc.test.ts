import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autostartCommand,
  autostartEnabled,
  desktopEntry,
  launchAgentPlist,
  shouldOfferAutostart,
  windowsRunArgs,
} from "../src/autostart";
import { checkForUpdate } from "../src/update";

test("first-run autostart question: only interactive, compiled, not asked before", () => {
  const base = { interactive: true, compiled: true, asked: false };
  expect(shouldOfferAutostart(base)).toBe(true);
  expect(shouldOfferAutostart({ ...base, interactive: false })).toBe(false); // e.g. started by the login entry
  expect(shouldOfferAutostart({ ...base, compiled: false })).toBe(false); // bun src/index.ts
  expect(shouldOfferAutostart({ ...base, asked: true })).toBe(false);
});

describe("autostart generators", () => {
  test("XDG .desktop entry quotes the path", () => {
    const d = desktopEntry("/home/u/my apps/gather-spotify-status");
    expect(d).toContain("[Desktop Entry]");
    expect(d).toContain('Exec="/home/u/my apps/gather-spotify-status" --autostart');
    expect(d).toContain("Terminal=false");
    expect(desktopEntry('/a/$b"c')).toContain('Exec="/a/\\$b\\"c" --autostart');
  });
  test("macOS LaunchAgent plist escapes XML and runs at load", () => {
    const p = launchAgentPlist("/Users/u/A&B/gather-spotify-status");
    expect(p).toContain("<string>/Users/u/A&amp;B/gather-spotify-status</string>");
    expect(p).toContain("<string>--autostart</string>");
    expect(p).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(p).not.toContain("KeepAlive");
  });
  test("Windows Run key args", () => {
    const a = windowsRunArgs(
      "C:\\Users\\u\\AppData\\Local\\Programs\\gather-spotify-status\\gather-spotify-status.exe",
    );
    expect(a.slice(0, 2)).toEqual(["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"]);
    expect(a).toContain(
      '"C:\\Users\\u\\AppData\\Local\\Programs\\gather-spotify-status\\gather-spotify-status.exe" --autostart',
    );
    expect(a.at(-1)).toBe("/f");
  });
});

describe("autostartCommand lifecycle", () => {
  let tempBase: string;
  let homeDir: string;
  let xdgDir: string;

  beforeAll(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "gss-autostart-test-"));
    homeDir = path.join(tempBase, "home");
    xdgDir = path.join(tempBase, "xdg");
  });

  afterAll(() => {
    fs.rmSync(tempBase, { recursive: true, force: true });
  });

  test("Linux: on writes .desktop, status reports on, off removes it", () => {
    const desktopPath = path.join(xdgDir, "autostart", "gather-spotify-status.desktop");
    const opts = { platform: "linux" as const, xdgConfigHome: xdgDir, binary: "/usr/bin/gather-spotify-status" };

    expect(autostartEnabled(opts)).toBe(false);
    expect(autostartCommand("status", opts)).toBe(true);

    expect(autostartCommand("on", opts)).toBe(true);
    expect(fs.existsSync(desktopPath)).toBe(true);
    expect(autostartEnabled(opts)).toBe(true);

    expect(autostartCommand("off", opts)).toBe(true);
    expect(fs.existsSync(desktopPath)).toBe(false);
    expect(autostartEnabled(opts)).toBe(false);
  });

  test("macOS: on writes .plist, status reports on, off removes it", () => {
    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.gather-spotify-status.plist");
    const opts = { platform: "darwin" as const, home: homeDir, binary: "/usr/local/bin/gather-spotify-status" };

    expect(autostartEnabled(opts)).toBe(false);
    expect(autostartCommand("on", opts)).toBe(true);
    expect(fs.existsSync(plistPath)).toBe(true);
    expect(autostartEnabled(opts)).toBe(true);

    expect(autostartCommand("off", opts)).toBe(true);
    expect(fs.existsSync(plistPath)).toBe(false);
    expect(autostartEnabled(opts)).toBe(false);
  });

  test("Windows: on, status, and off call registry handler", () => {
    const regCalls: string[][] = [];
    let queryStatus = 1;

    const opts = {
      platform: "win32" as const,
      binary: "C:\\Program Files\\gather-spotify-status\\gather-spotify-status.exe",
      runReg: (args: string[]) => {
        regCalls.push(args);
        if (args[0] === "query") return { status: queryStatus };
        if (args[0] === "add") queryStatus = 0;
        if (args[0] === "delete") queryStatus = 1;
        return { status: 0 };
      },
    };

    expect(autostartEnabled(opts)).toBe(false);
    expect(autostartCommand("on", opts)).toBe(true);
    expect(regCalls.some((c) => c[0] === "add")).toBe(true);
    expect(autostartEnabled(opts)).toBe(true);

    expect(autostartCommand("off", opts)).toBe(true);
    expect(regCalls.some((c) => c[0] === "delete")).toBe(true);
    expect(autostartEnabled(opts)).toBe(false);
  });
});

describe("update check (mock GitHub)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let latest = "9.9.9";
  let hits = 0;
  let base: string;
  const savedXdg = process.env.XDG_CONFIG_HOME;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        hits++;
        if (new URL(req.url).pathname === "/repos/me/app/releases/latest") {
          return Response.json({ tag_name: `v${latest}`, html_url: "https://example.test/release" });
        }
        return new Response("nope", { status: 404 });
      },
    });
    process.env.GSS_GITHUB_API = `http://127.0.0.1:${server.port}`;
    base = fs.mkdtempSync(path.join(os.tmpdir(), "gss-upd-"));
    process.env.XDG_CONFIG_HOME = base;
  });
  afterAll(() => {
    server.stop(true);
    delete process.env.GSS_GITHUB_API;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  test("disabled without a repo", async () => {
    expect(await checkForUpdate({ force: true, repo: "" })).toBeNull();
  });
  test("newer release found, then cached for 24h", async () => {
    const now = Date.now();
    expect(await checkForUpdate({ repo: "me/app", now })).toEqual({
      latest: "9.9.9",
      url: "https://example.test/release",
    });
    const before = hits;
    expect(await checkForUpdate({ repo: "me/app", now: now + 3600000 })).not.toBeNull();
    expect(hits).toBe(before); // cached
    latest = "0.0.1";
    expect(await checkForUpdate({ repo: "me/app", now: now + 25 * 3600000 })).toBeNull(); // re-fetched, older
    expect(hits).toBe(before + 1);
  });
  test("errors are silent", async () => {
    expect(await checkForUpdate({ force: true, repo: "me/missing" })).toBeNull();
  });
});

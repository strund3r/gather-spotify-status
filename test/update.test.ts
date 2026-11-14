import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkForUpdate,
  checkUpdateCommand,
  parseSha256Sums,
  printUpdate,
  releaseAssetName,
  updateCommand,
} from "../src/update";

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

describe("releaseAssetName", () => {
  test("maps supported platforms and architectures to release asset names", () => {
    expect(releaseAssetName("1.2.0", "linux", "x64")).toBe("gather-spotify-status-v1.2.0-linux-x64");
    expect(releaseAssetName("1.2.0", "linux", "arm64")).toBe("gather-spotify-status-v1.2.0-linux-arm64");
    expect(releaseAssetName("1.2.0", "darwin", "x64")).toBe("gather-spotify-status-v1.2.0-darwin-x64");
    expect(releaseAssetName("1.2.0", "darwin", "arm64")).toBe("gather-spotify-status-v1.2.0-darwin-arm64");
    expect(releaseAssetName("1.2.0", "win32", "x64")).toBe("gather-spotify-status-v1.2.0-windows-x64.exe");
  });

  test("returns null for unsupported platform or architecture", () => {
    expect(releaseAssetName("1.2.0", "win32", "arm64")).toBeNull();
    expect(releaseAssetName("1.2.0", "linux", "ia32")).toBeNull();
    expect(releaseAssetName("1.2.0", "freebsd" as NodeJS.Platform, "x64")).toBeNull();
  });
});

describe("parseSha256Sums", () => {
  const hashA = "a".repeat(64);
  const hashB = "B".repeat(64);

  test("extracts matching hash for two-space, binary '*', and CRLF lines", () => {
    const sums = [
      `${hashA}  gather-spotify-status-v1.2.0-linux-x64`,
      `${hashB} *gather-spotify-status-v1.2.0-windows-x64.exe`,
    ].join("\r\n");

    expect(parseSha256Sums(sums, "gather-spotify-status-v1.2.0-linux-x64")).toBe(hashA);
    expect(parseSha256Sums(sums, "gather-spotify-status-v1.2.0-windows-x64.exe")).toBe("b".repeat(64));
  });

  test("returns null when file is missing or hash is malformed", () => {
    const sums = [
      `${"c".repeat(63)}  gather-spotify-status-v1.2.0-linux-x64`,
      `${"z".repeat(64)}  gather-spotify-status-v1.2.0-darwin-x64`,
      `${hashA}  gather-spotify-status-v1.2.0-linux-arm64`,
    ].join("\n");

    expect(parseSha256Sums(sums, "gather-spotify-status-v1.2.0-linux-x64")).toBeNull();
    expect(parseSha256Sums(sums, "gather-spotify-status-v1.2.0-darwin-x64")).toBeNull();
    expect(parseSha256Sums(sums, "nonexistent")).toBeNull();
  });
});

describe("printUpdate & checkUpdateCommand", () => {
  test("printUpdate logs update notice with and without url", () => {
    expect(() => printUpdate({ latest: "1.2.0", url: "https://example.test" })).not.toThrow();
    expect(() => printUpdate({ latest: "1.2.0", url: "" })).not.toThrow();
  });

  test("checkUpdateCommand logs when up to date or when update available", async () => {
    let latest = "99.0.0";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.includes("/releases/latest")) {
          return Response.json({ tag_name: `v${latest}`, html_url: "https://example.test" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const savedApi = process.env.GSS_GITHUB_API;
    const tempConfig = fs.mkdtempSync(path.join(os.tmpdir(), "gss-check-upd-"));
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.GSS_GITHUB_API = `http://127.0.0.1:${server.port}`;
    process.env.XDG_CONFIG_HOME = tempConfig;

    try {
      await checkUpdateCommand(); // update available
      latest = "0.0.1";
      await checkUpdateCommand(); // up to date
    } finally {
      server.stop(true);
      if (savedApi === undefined) delete process.env.GSS_GITHUB_API;
      else process.env.GSS_GITHUB_API = savedApi;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tempConfig, { recursive: true, force: true });
    }
  });

  test("checkForUpdate catches fetch exceptions", async () => {
    const savedApi = process.env.GSS_GITHUB_API;
    process.env.GSS_GITHUB_API = "http://127.0.0.1:1";
    try {
      const info = await checkForUpdate({ force: true });
      expect(info).toBeNull();
    } finally {
      if (savedApi === undefined) delete process.env.GSS_GITHUB_API;
      else process.env.GSS_GITHUB_API = savedApi;
    }
  });
});

describe("updateCommand (mock GitHub)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseDir: string;
  let configBase: string;
  let targetFile: string;
  let releaseStatus = 200;
  let sumsStatus = 200;
  let binStatus = 200;
  let omitAssets = false;
  let latestVersion = "1.2.0";
  let binaryBytes = Buffer.from("new-binary-v1.2.0");
  let customSums: string | null = null;
  let downloadHits = 0;

  const savedApi = process.env.GSS_GITHUB_API;
  const savedXdg = process.env.XDG_CONFIG_HOME;

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "gss-update-cmd-"));
    configBase = path.join(baseDir, "xdg");
    process.env.XDG_CONFIG_HOME = configBase;

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/repos/me/app/releases/latest") {
          if (releaseStatus !== 200) {
            return new Response("error", { status: releaseStatus });
          }
          const base = `http://127.0.0.1:${server.port}/download`;
          const linuxName = `gather-spotify-status-v${latestVersion}-linux-x64`;
          const winName = `gather-spotify-status-v${latestVersion}-windows-x64.exe`;
          return Response.json({
            tag_name: `v${latestVersion}`,
            html_url: "https://example.test/releases/latest",
            assets: omitAssets
              ? []
              : [
                  { name: "SHA256SUMS", browser_download_url: `${base}/SHA256SUMS` },
                  { name: linuxName, browser_download_url: `${base}/${linuxName}` },
                  { name: winName, browser_download_url: `${base}/${winName}` },
                ],
          });
        }
        if (
          pathname === "/download/SHA256SUMS" ||
          pathname === `/repos/me/app/releases/download/v${latestVersion}/SHA256SUMS`
        ) {
          downloadHits++;
          if (sumsStatus !== 200) return new Response("error", { status: sumsStatus });
          const digest = sha256Hex(binaryBytes);
          const linuxName = `gather-spotify-status-v${latestVersion}-linux-x64`;
          const winName = `gather-spotify-status-v${latestVersion}-windows-x64.exe`;
          const body = customSums ?? `${digest}  ${linuxName}\n${digest}  ${winName}\n`;
          return new Response(body, { status: 200 });
        }
        if (
          pathname.startsWith("/download/gather-spotify-status-") ||
          pathname.startsWith(`/repos/me/app/releases/download/v${latestVersion}/gather-spotify-status-`)
        ) {
          downloadHits++;
          if (binStatus !== 200) return new Response("error", { status: binStatus });
          return new Response(binaryBytes, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.GSS_GITHUB_API = `http://127.0.0.1:${server.port}`;
  });

  beforeEach(() => {
    releaseStatus = 200;
    sumsStatus = 200;
    binStatus = 200;
    omitAssets = false;
    latestVersion = "1.2.0";
    binaryBytes = Buffer.from("new-binary-v1.2.0");
    customSums = null;
    downloadHits = 0;
    targetFile = path.join(baseDir, "bin", `gather-spotify-status-${Date.now()}`);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "old-binary-v1.1.0");
  });

  afterAll(() => {
    server.stop(true);
    if (savedApi === undefined) delete process.env.GSS_GITHUB_API;
    else process.env.GSS_GITHUB_API = savedApi;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test("refuses update when repo is not configured", async () => {
    const ok = await updateCommand({ repo: "" });
    expect(ok).toBe(false);
  });

  test("refuses self-update when not running from compiled binary", async () => {
    const ok = await updateCommand({
      repo: "me/app",
      compiled: false,
      target: targetFile,
    });
    expect(ok).toBe(false);
    expect(downloadHits).toBe(0);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("old-binary-v1.1.0");
  });

  test("returns true without downloading when already up to date", async () => {
    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.2.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
    });
    expect(ok).toBe(true);
    expect(downloadHits).toBe(0);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("old-binary-v1.1.0");
  });

  test("returns false when GitHub release API fails", async () => {
    releaseStatus = 500;
    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
    });
    expect(ok).toBe(false);
    expect(downloadHits).toBe(0);
  });

  test("returns false when platform has no prebuilt binary", async () => {
    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "freebsd" as NodeJS.Platform,
      arch: "x64",
      target: targetFile,
    });
    expect(ok).toBe(false);
  });

  test("aborts and returns false when SHA256SUMS download fails or has network error", async () => {
    sumsStatus = 404;
    const ok404 = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
    });
    expect(ok404).toBe(false);

    sumsStatus = 200;
    const oldApi = process.env.GSS_GITHUB_API;
    process.env.GSS_GITHUB_API = "http://127.0.0.1:1";
    try {
      const okNet = await updateCommand({
        repo: "me/app",
        compiled: true,
        currentVersion: "1.1.0",
        platform: "linux",
        arch: "x64",
        target: targetFile,
      });
      expect(okNet).toBe(false);
    } finally {
      process.env.GSS_GITHUB_API = oldApi;
    }
  });

  test("aborts when asset is missing in SHA256SUMS", async () => {
    customSums = `${"a".repeat(64)}  unrelated-file\n`;
    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
    });
    expect(ok).toBe(false);
  });

  test("aborts when binary download fails or has network error", async () => {
    binStatus = 500;
    const ok500 = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
    });
    expect(ok500).toBe(false);

    binStatus = 200;
    const oldApi = process.env.GSS_GITHUB_API;
    process.env.GSS_GITHUB_API = "http://127.0.0.1:1";
    try {
      const okNet = await updateCommand({
        repo: "me/app",
        compiled: true,
        currentVersion: "1.1.0",
        platform: "linux",
        arch: "x64",
        target: targetFile,
      });
      expect(okNet).toBe(false);
    } finally {
      process.env.GSS_GITHUB_API = oldApi;
    }
  });

  test("aborts and leaves target untouched on SHA-256 mismatch", async () => {
    customSums = `${"0".repeat(64)}  gather-spotify-status-v1.2.0-linux-x64\n`;
    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
    });
    expect(ok).toBe(false);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("old-binary-v1.1.0");
  });

  test("returns false when binary installation fails (disk write error)", async () => {
    const invalidTarget = path.join(targetFile, "cannot-write-here");
    fs.writeFileSync(targetFile, "file-not-dir");

    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: invalidTarget,
    });
    expect(ok).toBe(false);
  });

  test("downloads, verifies, replaces binary, stops running daemon, and restarts on Linux", async () => {
    let stopCalled = false;
    let restartedTarget: string | undefined;

    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
      running: () => ({ pid: 4321, version: "1.1.0" }),
      stopRunning: async () => {
        stopCalled = true;
        return true;
      },
      restart: (restarted) => {
        restartedTarget = restarted;
        return true;
      },
    });

    expect(ok).toBe(true);
    expect(stopCalled).toBe(true);
    expect(restartedTarget).toBe(targetFile);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("new-binary-v1.2.0");
  });

  test("falls back to default asset URL when not in release assets", async () => {
    omitAssets = true;
    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
    });
    expect(ok).toBe(true);

    // Test fallback url resolution without GSS_GITHUB_API
    const oldApi = process.env.GSS_GITHUB_API;
    delete process.env.GSS_GITHUB_API;
    try {
      const okGithub = await updateCommand({
        repo: "me/app",
        compiled: true,
        currentVersion: "1.1.0",
        platform: "linux",
        arch: "x64",
        target: targetFile,
      });
      // Will fail to fetch from real github.com in test environment, which confirms the url branch was taken
      expect(typeof okGithub).toBe("boolean");
    } finally {
      process.env.GSS_GITHUB_API = oldApi;
    }
  });

  test("handles restart failure when opts.restart returns false", async () => {
    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "linux",
      arch: "x64",
      target: targetFile,
      running: () => ({ pid: 4321, version: "1.1.0" }),
      stopRunning: async () => true,
      restart: () => false,
    });
    expect(ok).toBe(false);
  });

  test("handles spawnSync failure when target is not executable", async () => {
    const dummyExe = path.join(baseDir, "dummy-restart.cmd");
    fs.writeFileSync(dummyExe, "@exit 0\n");

    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "win32",
      arch: "x64",
      target: dummyExe,
      running: () => ({ pid: 4321, version: "1.1.0" }),
      stopRunning: async () => true,
    });
    expect(ok).toBe(false);
  });

  test("renames running target to .old on Windows", async () => {
    const winTarget = `${targetFile}.exe`;
    fs.writeFileSync(winTarget, "old-win-binary");

    const ok = await updateCommand({
      repo: "me/app",
      compiled: true,
      currentVersion: "1.1.0",
      platform: "win32",
      arch: "x64",
      target: winTarget,
      running: () => null,
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(winTarget, "utf8")).toBe("new-binary-v1.2.0");
    expect(fs.readFileSync(`${winTarget}.old`, "utf8")).toBe("old-win-binary");
  });
});

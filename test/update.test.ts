import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSha256Sums, releaseAssetName, updateCommand } from "../src/update";

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

describe("updateCommand (mock GitHub)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseDir: string;
  let configBase: string;
  let targetFile: string;
  let releaseStatus = 200;
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
            assets: [
              { name: "SHA256SUMS", browser_download_url: `${base}/SHA256SUMS` },
              { name: linuxName, browser_download_url: `${base}/${linuxName}` },
              { name: winName, browser_download_url: `${base}/${winName}` },
            ],
          });
        }
        if (pathname === "/download/SHA256SUMS") {
          downloadHits++;
          const digest = sha256Hex(binaryBytes);
          const linuxName = `gather-spotify-status-v${latestVersion}-linux-x64`;
          const winName = `gather-spotify-status-v${latestVersion}-windows-x64.exe`;
          const body = customSums ?? `${digest}  ${linuxName}\n${digest}  ${winName}\n`;
          return new Response(body, { status: 200 });
        }
        if (pathname.startsWith("/download/gather-spotify-status-")) {
          downloadHits++;
          return new Response(binaryBytes, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.GSS_GITHUB_API = `http://127.0.0.1:${server.port}`;
  });

  beforeEach(() => {
    releaseStatus = 200;
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

// End-to-end tests for install.ps1 and install.sh against a local mock GitHub release server.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SH_SCRIPT = path.join(ROOT, "install.sh");
const PS_SCRIPT = path.join(ROOT, "install.ps1");

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Locate powershell.exe (Windows) or pwsh so tests run when PowerShell is available. */
function findPowerShell(): string | null {
  const candidates = process.platform === "win32" ? ["powershell.exe", "pwsh"] : ["pwsh"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status === 0) return cmd;
  }
  return null;
}

/**
 * Run a child process asynchronously so the in-process Bun.serve mock server
 * can service HTTP requests from the child without blocking the event loop.
 */
function runAsync(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 25_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Feature gates keep platform-specific suites green on both Windows and POSIX CI runners.
const psCmd = findPowerShell();
const hasCurlAndSh =
  process.platform !== "win32" && spawnSync("/bin/sh", ["-c", "command -v curl >/dev/null 2>&1"]).status === 0;

describe("install scripts mock release suite", () => {
  let server: ReturnType<typeof Bun.serve>;
  let tmpBase: string;
  let customTag = "v1.2.0";
  let checksumMismatch = false;
  const linuxBytes = Buffer.from("fake-linux-binary-v1.2.0\n");
  const winBytes = Buffer.from("fake-windows-binary-v1.2.0\n");

  beforeAll(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gss-inst-scripts-"));
    // Mock both the GitHub releases API and release asset download endpoints on localhost.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/repos/me/app/releases/latest") {
          return Response.json({ tag_name: customTag });
        }
        if (pathname === "/me/app/releases/download/v1.2.0/SHA256SUMS") {
          const linuxHash = checksumMismatch ? "0".repeat(64) : sha256Hex(linuxBytes);
          const winHash = checksumMismatch ? "0".repeat(64) : sha256Hex(winBytes);
          return new Response(
            `${linuxHash}  gather-spotify-status-v1.2.0-linux-x64\n${winHash}  gather-spotify-status-v1.2.0-windows-x64.exe\n`,
            { status: 200 },
          );
        }
        if (pathname === "/me/app/releases/download/v1.2.0/gather-spotify-status-v1.2.0-linux-x64") {
          return new Response(linuxBytes, { status: 200 });
        }
        if (pathname === "/me/app/releases/download/v1.2.0/gather-spotify-status-v1.2.0-windows-x64.exe") {
          return new Response(winBytes, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  beforeEach(() => {
    customTag = "v1.2.0";
    checksumMismatch = false;
  });

  afterAll(() => {
    server.stop(true);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  describe.skipIf(!psCmd)("install.ps1", () => {
    function runPs(extraEnv: Record<string, string>) {
      const cmd = psCmd ?? "powershell.exe";
      const ps7Prefix = "C:\\Program Files\\PowerShell\\7\\Modules";
      const pollutedPsModulePath = process.env.PSModulePath ? `${ps7Prefix};${process.env.PSModulePath}` : ps7Prefix;
      return runAsync(cmd, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS_SCRIPT], {
        ...process.env,
        PSModulePath: pollutedPsModulePath, // simulate pwsh 7 parent on GitHub windows-latest runners
        GSS_REPO: "me/app",
        GSS_GITHUB_API: `http://127.0.0.1:${server.port}`,
        GSS_RELEASE_BASE: `http://127.0.0.1:${server.port}`,
        GSS_ARCH: "AMD64",
        GSS_SKIP_PATH: "1", // avoid mutating the real user registry Path in tests
        ...extraEnv,
      });
    }

    test("downloads, verifies SHA-256, installs binary, and backs up previous binary", async () => {
      const installDir = path.join(tmpBase, "ps-ok");
      const target = path.join(installDir, "gather-spotify-status.exe");

      // Fresh install writes the verified executable.
      const res1 = await runPs({ GSS_INSTALL_DIR: installDir });
      expect(res1.stderr).toBe("");
      expect(res1.status).toBe(0);
      expect(fs.readFileSync(target)).toEqual(winBytes);

      // Upgrade moves the existing executable to .old before installing the new one.
      fs.writeFileSync(target, "previous-version");
      const res2 = await runPs({ GSS_INSTALL_DIR: installDir });
      expect(res2.stderr).toBe("");
      expect(res2.status).toBe(0);
      expect(fs.readFileSync(target)).toEqual(winBytes);
      expect(fs.readFileSync(`${target}.old`, "utf8")).toBe("previous-version");
    }, 15_000);

    test("aborts without installing when SHA-256 checksum mismatches", async () => {
      checksumMismatch = true;
      const installDir = path.join(tmpBase, "ps-bad-hash");
      const res = await runPs({ GSS_INSTALL_DIR: installDir });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("Checksum verification failed");
      expect(fs.existsSync(path.join(installDir, "gather-spotify-status.exe"))).toBe(false);
    }, 15_000);

    test("rejects non-semver tag_name", async () => {
      customTag = "v1.2.0-evil";
      const installDir = path.join(tmpBase, "ps-bad-tag");
      const res = await runPs({ GSS_INSTALL_DIR: installDir });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("Invalid or missing release version");
      expect(fs.existsSync(path.join(installDir, "gather-spotify-status.exe"))).toBe(false);
    }, 15_000);

    test("rejects unsupported architecture", async () => {
      const installDir = path.join(tmpBase, "ps-bad-arch");
      const res = await runPs({ GSS_INSTALL_DIR: installDir, GSS_ARCH: "ARM64" });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("Unsupported architecture");
      expect(fs.existsSync(path.join(installDir, "gather-spotify-status.exe"))).toBe(false);
    }, 15_000);
  });

  describe.skipIf(!hasCurlAndSh)("install.sh", () => {
    function runSh(extraEnv: Record<string, string>) {
      return runAsync("/bin/sh", [SH_SCRIPT], {
        ...process.env,
        GSS_REPO: "me/app",
        GSS_GITHUB_API: `http://127.0.0.1:${server.port}`,
        GSS_RELEASE_BASE: `http://127.0.0.1:${server.port}`,
        GSS_UNAME_S: "Linux",
        GSS_UNAME_M: "x86_64",
        ...extraEnv,
      });
    }

    test("downloads, verifies SHA-256, installs executable binary, and updates shell rc PATH", async () => {
      const fakeHome = path.join(tmpBase, "sh-home");
      const installDir = path.join(tmpBase, "sh-ok-bin");
      fs.mkdirSync(fakeHome, { recursive: true });

      const res = await runSh({
        HOME: fakeHome,
        ZDOTDIR: fakeHome,
        SHELL: "/bin/zsh",
        GSS_INSTALL_DIR: installDir,
      });
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);

      // Binary exists with executable permissions and shell rc received the PATH export.
      const installed = path.join(installDir, "gather-spotify-status");
      expect(fs.readFileSync(installed)).toEqual(linuxBytes);
      expect(fs.statSync(installed).mode & 0o111).not.toBe(0);

      const zshrc = fs.readFileSync(path.join(fakeHome, ".zshrc"), "utf8");
      expect(zshrc).toContain(`export PATH="${installDir}:$PATH"  # added by gather-spotify-status`);
    });

    test("aborts without installing when SHA-256 checksum mismatches", async () => {
      checksumMismatch = true;
      const installDir = path.join(tmpBase, "sh-bad-hash");
      const res = await runSh({ GSS_INSTALL_DIR: installDir, GSS_SKIP_PATH: "1" });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("checksum verification failed");
      expect(fs.existsSync(path.join(installDir, "gather-spotify-status"))).toBe(false);
    });

    test("rejects non-semver tag_name", async () => {
      customTag = "v1.2.0-evil";
      const installDir = path.join(tmpBase, "sh-bad-tag");
      const res = await runSh({ GSS_INSTALL_DIR: installDir, GSS_SKIP_PATH: "1" });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("invalid or missing release version");
      expect(fs.existsSync(path.join(installDir, "gather-spotify-status"))).toBe(false);
    });

    test("rejects unsupported OS", async () => {
      const installDir = path.join(tmpBase, "sh-bad-os");
      const res = await runSh({ GSS_INSTALL_DIR: installDir, GSS_SKIP_PATH: "1", GSS_UNAME_S: "FreeBSD" });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toContain("unsupported OS");
      expect(fs.existsSync(path.join(installDir, "gather-spotify-status"))).toBe(false);
    });
  });
});

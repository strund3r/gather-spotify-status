import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureOnPath, maybeInstall } from "../src/install";
import { VERSION } from "../src/version";

describe("ensureOnPath", () => {
  const saved = {
    HOME: process.env.HOME,
    SHELL: process.env.SHELL,
    PATH: process.env.PATH,
    ZDOTDIR: process.env.ZDOTDIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  let home: string;
  let dir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gss-home-"));
    dir = path.join(home, ".local", "bin");
    if (!home.startsWith(os.tmpdir())) throw new Error("refusing to touch a non-temp home");
    process.env.HOME = home;
    process.env.PATH = "/usr/bin:/bin";
    delete process.env.ZDOTDIR;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("zsh: appends one marked line, idempotent", () => {
    process.env.SHELL = "/bin/zsh";
    expect(ensureOnPath(dir, home, "linux")).toBe("added");
    expect(ensureOnPath(dir, home, "linux")).toBe("added"); // marker already there → no duplicate
    const rc = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
    expect(rc.match(/added by gather-spotify-status/g)?.length).toBe(1);
    expect(rc).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  test("bash: ~/.bashrc (plus ~/.bash_profile on macOS)", () => {
    process.env.SHELL = "/bin/bash";
    fs.writeFileSync(path.join(home, ".bashrc"), "alias x=y"); // no trailing newline
    expect(ensureOnPath(dir, home, "darwin")).toBe("added");
    const rc = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
    expect(rc.startsWith("alias x=y\n")).toBe(true);
    expect(fs.existsSync(path.join(home, ".bash_profile"))).toBe(true);
  });

  test("fish: conf.d file", () => {
    process.env.SHELL = "/usr/bin/fish";
    expect(ensureOnPath(dir, home, "linux")).toBe("added");
    const f = fs.readFileSync(path.join(home, ".config", "fish", "conf.d", "gather-spotify-status.fish"), "utf8");
    expect(f).toContain("fish_add_path ~/.local/bin");
  });

  test("unknown shell: ~/.profile", () => {
    process.env.SHELL = "/bin/ksh";
    expect(ensureOnPath(dir, home, "linux")).toBe("added");
    expect(fs.readFileSync(path.join(home, ".profile"), "utf8")).toContain(".local/bin");
  });

  test("already on PATH: nothing written", () => {
    process.env.SHELL = "/bin/zsh";
    fs.mkdirSync(dir, { recursive: true });
    process.env.PATH = `${dir}${path.delimiter}/usr/bin`;
    expect(ensureOnPath(dir, home, "linux")).toBe("already");
    expect(fs.existsSync(path.join(home, ".zshrc"))).toBe(false);
  });
});

describe("maybeInstall", () => {
  let tempDir: string;
  let homeDir: string;
  let srcFile: string;
  let targetFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gss-install-test-"));
    homeDir = path.join(tempDir, "home");
    srcFile = path.join(tempDir, "bin-downloaded");
    targetFile = path.join(homeDir, ".local", "bin", "gather-spotify-status");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(srcFile, "#!/bin/sh\necho fake-bin");
    fs.chmodSync(srcFile, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("noop when not compiled or already marked installed", async () => {
    let reExecCalled = false;
    await maybeInstall({
      compiled: false,
      self: srcFile,
      target: targetFile,
      home: homeDir,
      platform: "linux",
      reExec: async () => {
        reExecCalled = true;
      },
    });
    expect(reExecCalled).toBe(false);
    expect(fs.existsSync(targetFile)).toBe(false);

    const oldEnv = process.env.GSS_INSTALLED;
    process.env.GSS_INSTALLED = "1";
    try {
      await maybeInstall({
        compiled: true,
        self: srcFile,
        target: targetFile,
        home: homeDir,
        platform: "linux",
        reExec: async () => {
          reExecCalled = true;
        },
      });
      expect(reExecCalled).toBe(false);
      expect(fs.existsSync(targetFile)).toBe(false);
    } finally {
      if (oldEnv === undefined) delete process.env.GSS_INSTALLED;
      else process.env.GSS_INSTALLED = oldEnv;
    }
  });

  test("fresh install copies binary, sets executable, and reExecs", async () => {
    let reExecEnv: Record<string, string> | undefined;
    let reExecTarget: string | undefined;

    await maybeInstall({
      compiled: true,
      self: srcFile,
      target: targetFile,
      home: homeDir,
      platform: "linux",
      installedVersion: () => null,
      reExec: async (env, target) => {
        reExecEnv = env;
        reExecTarget = target;
      },
    });

    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("#!/bin/sh\necho fake-bin");
    expect(reExecEnv?.GSS_INSTALLED).toBe("1");
    expect(reExecTarget).toBe(targetFile);
  });

  test("skips install if already at same version", async () => {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "existing-same-version");

    let reExecCalled = false;
    await maybeInstall({
      compiled: true,
      self: srcFile,
      target: targetFile,
      home: homeDir,
      platform: "linux",
      installedVersion: () => VERSION,
      reExec: async () => {
        reExecCalled = true;
      },
    });

    expect(reExecCalled).toBe(false);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("existing-same-version");
  });

  test("skips install if installed version is newer", async () => {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "existing-newer-version");

    let reExecCalled = false;
    await maybeInstall({
      compiled: true,
      self: srcFile,
      target: targetFile,
      home: homeDir,
      platform: "linux",
      installedVersion: () => "2.0.0",
      reExec: async () => {
        reExecCalled = true;
      },
    });

    expect(reExecCalled).toBe(false);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("existing-newer-version");
  });

  test("upgrades when installed version is older and stops running instance", async () => {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "existing-older-version");

    let stopCalled = false;
    let reExecTarget: string | undefined;

    await maybeInstall({
      compiled: true,
      self: srcFile,
      target: targetFile,
      home: homeDir,
      platform: "linux",
      installedVersion: () => "0.9.0",
      running: () => ({ pid: 1234, version: "0.9.0" }),
      stopRunning: async () => {
        stopCalled = true;
        return true;
      },
      reExec: async (_env, target) => {
        reExecTarget = target;
      },
    });

    expect(stopCalled).toBe(true);
    expect(reExecTarget).toBe(targetFile);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("#!/bin/sh\necho fake-bin");
  });
});

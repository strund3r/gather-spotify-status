import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureOnPath } from "../src/install";

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

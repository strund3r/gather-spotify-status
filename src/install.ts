// SPDX-License-Identifier: GPL-3.0-or-later
// Self-install: copy the binary to the per-user bin folder and put that folder on PATH.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { err, out } from "./colors";
import { APP_NAME } from "./constants";
import { stopDaemon } from "./daemon";
import { xdgConfigHome } from "./paths";
import { runningInstance } from "./pidfile";
import { isCompiledBinary, reExec } from "./proc";
import { compareSemver, errorMessage } from "./util";
import { VERSION } from "./version";

const PATH_MARKER = `# added by ${APP_NAME}`;
const VERSION_PROBE_TIMEOUT_MS = 5000;
const PATH_UPDATE_TIMEOUT_MS = 15_000;

function installDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Programs", APP_NAME);
  }
  return path.join(os.homedir(), ".local", "bin");
}

export function installPath(): string {
  return path.join(installDir(), process.platform === "win32" ? `${APP_NAME}.exe` : APP_NAME);
}

/** Version of the installed binary, or null if it can't tell (not our binary, or it failed to run). */
function installedVersion(target: string): string | null {
  const res = spawnSync(target, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    env: { ...process.env, GSS_INSTALLED: "1" },
  });
  if (res.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(res.stdout ?? "")?.[1] ?? null;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r: string;
    try {
      r = fs.realpathSync(p);
    } catch {
      r = path.resolve(p);
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function displayDir(dir: string, home = os.homedir()): string {
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

type PathResult = "already" | "added" | "failed";

/**
 * Make sure `dir` is on the user's PATH for future shells. Silent unless it changes something.
 * `home` and `platform` are parameters so tests can use a temp dir without touching the real environment.
 */
export function ensureOnPath(
  dir: string,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): PathResult {
  const onPath = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((p) => samePath(p, dir));
  if (onPath) return "already";

  if (platform === "win32") {
    const script =
      "$d = $env:GSS_PATH_DIR; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $p) { $p = '' }; " +
      "if (($p -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';'), $d) -join ';').TrimStart(';'), 'User') }";
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, GSS_PATH_DIR: dir },
      windowsHide: true,
      timeout: PATH_UPDATE_TIMEOUT_MS,
    });
    if (res.status === 0) {
      console.log(out.dim(`Added ${dir} to your user PATH.`));
      return "added";
    }
    console.warn(
      err.yellow(`Could not update PATH automatically. Add ${dir} to your PATH to run '${APP_NAME}' from anywhere.`),
    );
    return "failed";
  }

  const shell = path.basename(process.env.SHELL || "");
  const dirExpr = dir === path.join(home, ".local", "bin") ? "$HOME/.local/bin" : dir;
  const exportLine = `export PATH="${dirExpr}:$PATH"  ${PATH_MARKER}`;

  let targets: { file: string; line: string }[];
  if (shell === "zsh") {
    targets = [{ file: path.join(process.env.ZDOTDIR || home, ".zshrc"), line: exportLine }];
  } else if (shell === "bash") {
    targets = [{ file: path.join(home, ".bashrc"), line: exportLine }];
    if (platform === "darwin") targets.push({ file: path.join(home, ".bash_profile"), line: exportLine });
  } else if (shell === "fish") {
    const fishDir = dir === path.join(home, ".local", "bin") ? "~/.local/bin" : dir;
    targets = [
      {
        file: path.join(xdgConfigHome(home), "fish", "conf.d", `${APP_NAME}.fish`),
        line: `fish_add_path ${fishDir}  ${PATH_MARKER}`,
      },
    ];
  } else {
    targets = [{ file: path.join(home, ".profile"), line: exportLine }];
  }

  const changed: string[] = [];
  for (const { file, line } of targets) {
    try {
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (content.includes(PATH_MARKER)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const prefix = content && !content.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(file, `${prefix}\n${line}\n`);
      changed.push(file);
    } catch (e) {
      console.warn(err.yellow(`Could not update ${file} (${errorMessage(e)}).`));
    }
  }
  if (changed.length) {
    console.log(
      out.dim(`Added ${displayDir(dir, home)} to PATH in ${changed.map((f) => displayDir(f, home)).join(", ")}.`),
    );
    return "added";
  }
  // Nothing written: either the marker was already there (PATH set up earlier, terminal not reopened yet) or it failed.
  return targets.some(({ file }) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(PATH_MARKER))
    ? "added"
    : "failed";
}

/** Tell the user how to start the app next time. */
function printNextTimeHint(pathResult: PathResult, target: string): void {
  const cmd = out.bold(out.cyan(APP_NAME));
  if (pathResult === "already") {
    console.log(`From now on, just run: ${cmd}`);
  } else if (pathResult === "added") {
    console.log(`From now on, just run: ${cmd}  ${out.dim("(in a new terminal)")}`);
  } else {
    console.log(`From now on, run: ${out.bold(out.cyan(target))}`);
  }
}

/**
 * First run / new version: move this binary to the per-user install location, put that on PATH,
 * and continue the run from the installed copy. No-op in dev mode, the daemon, or when installed.
 */
export async function maybeInstall(): Promise<void> {
  if (!isCompiledBinary() || process.env.GSS_INSTALLED === "1") return;

  const self = process.execPath;
  const target = installPath();
  if (samePath(self, target)) return;

  let oldVersion: string | null = null;
  const upgrading = fs.existsSync(target);
  if (upgrading) {
    oldVersion = installedVersion(target);
    if (oldVersion && compareSemver(VERSION, oldVersion) === 0) {
      console.log(out.dim(`v${VERSION} is already installed at ${target}.`));
      printNextTimeHint(ensureOnPath(installDir()), target);
      return;
    }
    if (oldVersion && compareSemver(VERSION, oldVersion) < 0) {
      console.warn(
        err.yellow(
          `Installed v${oldVersion} is newer than this copy (v${VERSION}); running this copy without installing.`,
        ),
      );
      return;
    }
  }

  const running = runningInstance();
  if (running) {
    console.log(out.yellow(`Stopping running v${running.version} (PID ${running.pid}) to upgrade...`));
    await stopDaemon();
  }

  try {
    fs.mkdirSync(installDir(), { recursive: true });
    const tmp = `${target}.new`;
    fs.copyFileSync(self, tmp);
    fs.chmodSync(tmp, 0o755);
    if (process.platform === "win32" && fs.existsSync(target)) {
      // A running .exe can't be overwritten, but it can be renamed.
      try {
        fs.unlinkSync(`${target}.old`);
      } catch {
        // no previous .old
      }
      fs.renameSync(target, `${target}.old`);
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    console.error(err.red(`Could not install to ${target} (${errorMessage(e)}). Running this copy instead.`));
    return;
  }

  console.log(
    out.green(
      upgrading
        ? `✓ Upgraded ${oldVersion ? `v${oldVersion}` : "previous version"} → ${out.bold(`v${VERSION}`)}`
        : `✓ Installed ${out.bold(`v${VERSION}`)}`,
    ) + out.dim(` at ${target}`),
  );

  // "Move": remove the downloaded copy. Windows can't delete a running .exe.
  if (process.platform === "win32") {
    console.log(out.dim(`You can delete ${self}`));
  } else {
    try {
      fs.unlinkSync(self);
    } catch (e) {
      console.warn(err.yellow(`Could not remove ${self} (${errorMessage(e)}); you can delete it.`));
    }
  }

  printNextTimeHint(ensureOnPath(installDir()), target);
  console.log();

  await reExec({ GSS_INSTALLED: "1" }, target);
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Where things live on disk. Everything is computed per call (env vars may change in tests).
import os from "node:os";
import path from "node:path";
import { APP_NAME } from "./constants";

/** $XDG_CONFIG_HOME or ~/.config (POSIX). */
export function xdgConfigHome(home = os.homedir()): string {
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

/** Per-user config directory: %APPDATA%\gather-spotify-status or $XDG_CONFIG_HOME/gather-spotify-status. */
export function configDir(): string {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, APP_NAME);
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, APP_NAME);
  }
  return path.join(xdgConfigHome(), APP_NAME);
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function logPath(): string {
  return path.join(configDir(), `${APP_NAME}.log`);
}

export function pidPath(): string {
  return path.join(configDir(), `${APP_NAME}.pid`);
}

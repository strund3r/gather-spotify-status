// SPDX-License-Identifier: GPL-3.0-or-later
// --autostart on|off|status: start the app when you log in to your computer.
// The login entry runs `<installed binary> --autostart`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { err, out } from "./colors";
import { autostartAsked, markAutostartAsked } from "./config";
import { APP_NAME } from "./constants";
import { UserError } from "./errors";
import { installPath } from "./install";
import { xdgConfigHome } from "./paths";
import { isCompiledBinary } from "./proc";
import { ask } from "./prompt";
import { errorMessage } from "./util";

const LABEL = `com.${APP_NAME}`;
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// --- generators (pure, unit-tested) -----------------------------------------

/** Quote for a .desktop Exec= line (spec: double quotes; escape \ " ` $). */
function desktopQuote(p: string): string {
  return `"${p.replace(/[\\"`$]/g, (ch) => `\\${ch}`)}"`;
}

export function desktopEntry(binary: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    "Comment=Set your Gather status to what you're playing on Spotify",
    `Exec=${desktopQuote(binary)} --autostart`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchAgentPlist(binary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(binary)}</string>
    <string>--autostart</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

/** Arguments for `reg add` (no shell involved). */
export function windowsRunArgs(binary: string): string[] {
  return ["add", RUN_KEY, "/v", APP_NAME, "/t", "REG_SZ", "/d", `"${binary}" --autostart`, "/f"];
}

// --- paths -------------------------------------------------------------------

function linuxEntryPath(): string {
  return path.join(xdgConfigHome(), "autostart", `${APP_NAME}.desktop`);
}

function macPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** The binary the login entry should start: the installed copy if present, else this one. */
function targetBinary(): string | null {
  if (!isCompiledBinary()) return null;
  return fs.existsSync(installPath()) ? installPath() : process.execPath;
}

// --- commands ----------------------------------------------------------------

function autostartEnabled(): boolean {
  if (process.platform === "win32") {
    return spawnSync("reg", ["query", RUN_KEY, "/v", APP_NAME], { windowsHide: true }).status === 0;
  }
  return fs.existsSync(process.platform === "darwin" ? macPlistPath() : linuxEntryPath());
}

export function autostartCommand(action: "on" | "off" | "status"): boolean {
  if (action !== "status") markAutostartAsked(); // the user decided; don't ask on first run
  if (action === "status") {
    console.log(autostartEnabled() ? out.green("● Start at login: on") : out.dim("○ Start at login: off"));
    return true;
  }

  if (action === "off") {
    if (process.platform === "win32") {
      spawnSync("reg", ["delete", RUN_KEY, "/v", APP_NAME, "/f"], { windowsHide: true });
    } else {
      fs.rmSync(process.platform === "darwin" ? macPlistPath() : linuxEntryPath(), { force: true });
    }
    console.log(out.green("✓ Start at login turned off."));
    return true;
  }

  const binary = targetBinary();
  if (!binary) {
    console.error(err.red("Start at login only works with the compiled binary (not `npm run dev`)."));
    return false;
  }
  try {
    if (process.platform === "win32") {
      const r = spawnSync("reg", windowsRunArgs(binary), { windowsHide: true });
      if (r.status !== 0) throw new Error(`reg add exited with ${r.status}`);
    } else {
      const file = process.platform === "darwin" ? macPlistPath() : linuxEntryPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, process.platform === "darwin" ? launchAgentPlist(binary) : desktopEntry(binary));
    }
  } catch (e) {
    console.error(err.red(`Could not turn on start at login: ${errorMessage(e)}`));
    return false;
  }
  console.log(out.green("✓ Start at login turned on.") + out.dim(` It runs ${binary} --autostart when you log in.`));
  console.log(
    out.dim("  If your Spotify login is still saved it starts silently; otherwise your browser opens to log in."),
  );
  return true;
}

// --- first-run question ------------------------------------------------------

export interface OfferState {
  /** stdin and stdout are a terminal. */
  interactive: boolean;
  /** Login entries only work for the compiled binary. */
  compiled: boolean;
  /** Asked before, or the user already ran --autostart on/off. */
  asked: boolean;
}

/** Whether to ask "start at login?" (pure; the "already on" check runs separately, it can be slow). */
export function shouldOfferAutostart(s: OfferState): boolean {
  return s.interactive && s.compiled && !s.asked;
}

function howToChange(): string {
  return out.dim(`Change it any time: ${APP_NAME} --autostart on | off   (check: ${APP_NAME} --autostart status)`);
}

/**
 * First run: offer to start the app when the user logs in. Asked once; the answer isn't stored as a
 * setting because the login entry itself is the state (see --autostart status).
 */
export async function offerAutostart(): Promise<void> {
  const state: OfferState = {
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    compiled: isCompiledBinary(),
    asked: autostartAsked(),
  };
  if (!shouldOfferAutostart(state)) return;
  if (autostartEnabled()) {
    markAutostartAsked();
    return;
  }

  console.log();
  let answer: string;
  try {
    answer = (await ask(`Start ${APP_NAME} automatically when you log in to this computer? [y/N] `))
      .trim()
      .toLowerCase();
  } catch (e) {
    if (e instanceof UserError) return; // Ctrl+C: ask again next time
    throw e;
  }
  markAutostartAsked();
  if (answer === "y" || answer === "yes") {
    autostartCommand("on");
  } else {
    console.log(out.dim("○ Start at login: off"));
  }
  console.log(howToChange());
}

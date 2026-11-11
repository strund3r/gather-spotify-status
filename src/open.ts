// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";

/** Assume success if the opener is still running after this long (some keep running). */
const OPEN_TIMEOUT_MS = 3000;

function opener(target: string): [command: string, args: string[]] {
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", target]];
  if (process.platform === "darwin") return ["open", [target]];
  return ["xdg-open", [target]];
}

/**
 * Open a URL or file with the OS default handler (browser, PDF viewer, ...).
 * Resolves true if the opener reported success (or is still running after a few seconds),
 * false if it couldn't be started or exited with an error, e.g. no desktop on a headless box.
 */
export function openExternal(target: string): Promise<boolean> {
  const [cmd, args] = opener(target);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => finish(false));
      child.on("exit", (code) => finish(code === 0));
      // Not unref'd: the caller awaits the result (callers exit explicitly afterwards).
      setTimeout(() => finish(true), OPEN_TIMEOUT_MS);
    } catch {
      finish(false);
    }
  });
}

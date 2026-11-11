// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal ANSI colors. Disabled when the stream isn't a terminal (e.g. the daemon's log file)
// or when NO_COLOR is set (https://no-color.org). FORCE_COLOR=1 forces them on.
// Checked on every call, so tests and env changes take effect.

function enabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY && process.env.TERM !== "dumb";
}

function palette(stream: () => NodeJS.WriteStream) {
  const wrap = (open: number, close: number) => (s: string) =>
    enabled(stream()) ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    underline: wrap(4, 24),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/** Colors for stdout (console.log). */
export const out = palette(() => process.stdout);
/** Colors for stderr (console.error / console.warn): use these for warnings and errors. */
export const err = palette(() => process.stderr);

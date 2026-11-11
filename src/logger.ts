// SPDX-License-Identifier: GPL-3.0-or-later
// Service logging (poller, token refresh, Gather connection, shutdown).
// The daemon's stdout/stderr are the log file and it turns timestamps on; in --foreground the same
// messages go to the terminal without them.

let timestamps = false;
let debugEnabled: () => boolean = () => false;

export function configureLogger(opts: { timestamps?: boolean; debug?: () => boolean }): void {
  if (opts.timestamps !== undefined) timestamps = opts.timestamps;
  if (opts.debug) debugEnabled = opts.debug;
}

/** ISO timestamp used as the prefix of every log-file line. */
export function stamp(): string {
  return new Date().toISOString();
}

function write(stream: NodeJS.WriteStream, message: string): void {
  try {
    stream.write(`${timestamps ? `${stamp()} ` : ""}${message}\n`);
  } catch {
    // never let logging crash the app
  }
}

export const logger = {
  info: (message: string): void => write(process.stdout, message),
  warn: (message: string): void => write(process.stderr, `[warn] ${message}`),
  error: (message: string): void => write(process.stderr, `[error] ${message}`),
  debug: (message: string): void => {
    if (debugEnabled()) write(process.stdout, `[debug] ${message}`);
  },
};

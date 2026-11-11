// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An expected failure with a message meant for the user (bad config, missing TTY, ...).
 * Thrown anywhere; caught in index.ts, which prints the message (no stack) and exits with `exitCode`.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "UserError";
  }
}

/** Invalid command-line usage: like UserError, but index.ts also prints the help text. Exit code 2. */
export class UsageError extends UserError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

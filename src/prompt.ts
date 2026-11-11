// SPDX-License-Identifier: GPL-3.0-or-later
// Interactive terminal prompts (first-time setup, TLS question).
import readline from "node:readline";
import { UserError } from "./errors";

/** Exit code for Ctrl+C at a prompt (128 + SIGINT), like shells use. */
const CANCELLED_EXIT_CODE = 130;

/**
 * Ask a question on the terminal. When `secret` is true, typed characters are masked with '*'.
 * Ctrl+C rejects with a UserError (exit code 130).
 */
export function ask(question: string, secret = false): Promise<string> {
  if (!secret) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) =>
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      }),
    );
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          finish();
          reject(new UserError("Cancelled.", CANCELLED_EXIT_CODE));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // ignore other control chars
        value += ch;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

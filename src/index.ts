// SPDX-License-Identifier: GPL-3.0-or-later
// Entry point: dispatch commands, start the launcher / background process / foreground service.
// The only place that turns errors into exit codes (see UserError).
import { autostartCommand, offerAutostart } from "./autostart";
import { type Flags, HELP, parseFlags } from "./cli";
import { err, out } from "./colors";
import {
  type Config,
  deleteRefreshToken,
  loadConfig,
  loadRefreshToken,
  loadSettings,
  resetConfig,
  saveRefreshToken,
  saveSetting,
  setConfigCommand,
  setupCommand,
} from "./config";
import { APP_NAME } from "./constants";
import { controlRunning, notifyReady, printStatus, receiveInit, spawnDaemon, stopDaemon } from "./daemon";
import { doctorCommand } from "./doctor";
import { UsageError, UserError } from "./errors";
import { maybeInstall } from "./install";
import { logLine, openLog, timestampConsole } from "./logfile";
import { configureLogger, logger } from "./logger";
import { followLogs } from "./logs";
import { spotifyLogin } from "./oauth";
import { configPath, logPath } from "./paths";
import { runningInstance } from "./pidfile";
import { openReadme } from "./readme";
import { describeSettings, parseSetArg, type SettingKey } from "./settings";
import { refreshTokens, type TokenSet } from "./spotify";
import { ensureTls } from "./tls";
import { checkForUpdate, checkUpdateCommand, printUpdate } from "./update";
import { describeError, sleep } from "./util";
import { VERSION } from "./version";

/** Started at login: give the network a moment to come up. */
const AUTOSTART_DELAY_MS = 20_000;
/** After starting the daemon, wait this long for the update notice before returning. */
const UPDATE_NOTICE_WAIT_MS = 500;

/** Exit code, or undefined to keep running (daemon, --foreground, --logs). */
type Outcome = number | undefined;

const exitCode = (ok: boolean): number => (ok ? 0 : 1);

// ---------------------------------------------------------------------------
// One-shot commands
// ---------------------------------------------------------------------------

function printSettings(only?: SettingKey): void {
  for (const row of describeSettings(loadSettings(), only)) {
    console.log(`${out.bold(row.key)} = ${out.cyan(row.value)}${row.isDefault ? out.dim(" (default)") : ""}`);
    if (!only) console.log(out.dim(`    ${row.describe}`));
  }
}

async function setSettings(args: string[]): Promise<void> {
  // Validate everything before saving anything.
  const parsed = args.map((a) => {
    try {
      return parseSetArg(a);
    } catch (e) {
      throw new UserError(e instanceof Error ? e.message : String(e), 2);
    }
  });
  for (const { key, value } of parsed) {
    saveSetting(key, value);
    const shown = describeSettings(loadSettings(), key)[0]?.value ?? "";
    console.log(`${out.green(`✓ ${key}`)} = ${out.cyan(shown)}`);
  }
  const r = await controlRunning("reload");
  if (r === "ok") console.log(out.dim("Applied to the running instance."));
  else if (r === "failed") {
    console.warn(err.yellow("Saved, but the running instance didn't respond; it applies on the next start."));
  }
}

async function pauseResume(action: "pause" | "resume"): Promise<boolean> {
  const r = await controlRunning(action);
  if (r === "not-running") {
    console.log(out.dim("Not running."));
    return false;
  }
  if (r === "failed") {
    console.error(err.red("The running instance didn't respond. If it was started by an older version, restart it."));
    return false;
  }
  console.log(action === "pause" ? out.yellow("⏸ Paused; your Gather status is cleared.") : out.green("▶ Resumed."));
  return true;
}

async function logout(): Promise<void> {
  if (runningInstance()) await stopDaemon();
  await deleteRefreshToken();
  console.log(out.green("✓ Logged out of Spotify.") + out.dim(" The next start asks you to log in again."));
}

/** Commands that do one thing and exit. "none" = not a one-shot command line. */
async function runOneShot(flags: Flags): Promise<Outcome | "none"> {
  if (flags.stop) return exitCode(await stopDaemon());
  if (flags.status) {
    await printStatus();
    return 0;
  }
  if (flags.doctor) return exitCode(await doctorCommand());
  if (flags.readme) return exitCode(await openReadme());
  if (flags.logs !== undefined) return followLogs(flags.logs);
  if (flags.checkUpdate) {
    await checkUpdateCommand();
    return 0;
  }
  if (flags.get || flags.set.length) {
    if (flags.set.length) await setSettings(flags.set);
    if (flags.get) printSettings(flags.get === "all" ? undefined : flags.get);
    return 0;
  }
  if (flags.pause || flags.resume) return exitCode(await pauseResume(flags.pause ? "pause" : "resume"));
  if (flags.autostartAction) return exitCode(autostartCommand(flags.autostartAction));
  if (flags.setup || flags.setConfig.length) {
    if (flags.setup) await setupCommand();
    if (flags.setConfig.length) await setConfigCommand(flags.setConfig);
    if (runningInstance()) {
      console.log(out.dim(`Restart ${APP_NAME} (${APP_NAME} --stop && ${APP_NAME}) to apply new credentials.`));
    }
    return 0;
  }
  if (flags.logout) {
    await logout();
    return 0;
  }
  return "none";
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Reuse the saved Spotify login if possible, else run the browser login. Saves the refresh token. */
async function obtainTokens(cfg: Config): Promise<TokenSet> {
  const saved = await loadRefreshToken();
  if (saved) {
    const r = await refreshTokens(cfg, saved);
    if (r.ok) {
      console.log(out.green("✓ Logged in to Spotify.") + out.dim(" (saved login)"));
      await saveRefreshToken(r.tokens.refreshToken);
      return r.tokens;
    }
    if (r.revoked) {
      await deleteRefreshToken();
      console.log(out.yellow("Your saved Spotify login expired; please log in again."));
    } else {
      console.log(out.yellow(`Couldn't use the saved Spotify login (${r.message}); logging in via the browser.`));
    }
  }
  const tokens = await spotifyLogin(cfg);
  if (!(await saveRefreshToken(tokens.refreshToken))) {
    console.log(out.dim("(Couldn't save the Spotify login; you'll log in again next time.)"));
  }
  return tokens;
}

/** What to do with an error that escaped everything else. Replaced once the service runs. */
let onFatal = (e: unknown): void => {
  console.error(err.red(describeError(e)));
  process.exit(1);
};

/** Background process: started by spawnDaemon(), stdout/stderr go to the log file. */
async function runDaemon(): Promise<Outcome> {
  const initPromise = receiveInit(); // listen before anything async so the IPC message isn't missed
  timestampConsole();
  configureLogger({ timestamps: true });
  process.on("SIGHUP", () => {}); // survive the terminal closing
  logger.info(`--- daemon v${VERSION} started (PID ${process.pid}) ---`);
  const init = await initPromise;
  const service = await (await import("./service")).runService(init.cfg, init.tokens, {
    debug: init.debug,
    logFd: openLog(),
    onReady: notifyReady,
  });
  onFatal = (e) => {
    logger.error(`Unexpected error: ${describeError(e)}`);
    void service.shutdown("Unexpected error", 1);
  };
  return undefined;
}

async function start(flags: Flags): Promise<Outcome> {
  if (!flags.noInstall && !flags.autostartRun) await maybeInstall(); // may restart from the installed copy

  const running = runningInstance();
  if (running) {
    if (flags.autostartRun) return 0; // already up; nothing to do
    console.error(
      `${err.yellow(`Already running v${running.version} (PID ${running.pid}).`)} Stop it with: ${err.cyan(`${APP_NAME} --stop`)}`,
    );
    return 1;
  }

  if (flags.autostartRun) await sleep(AUTOSTART_DELAY_MS);

  if (flags.reset) await resetConfig();
  const cfg = await loadConfig();
  await ensureTls({ insecure: flags.insecure });

  const logFd = openLog();
  const mode = flags.foreground ? "foreground" : flags.autostartRun ? "autostart" : "launcher";
  logLine(logFd, `--- start v${VERSION} (${mode}, PID ${process.pid}) ---`);

  const update = checkForUpdate().then((info) => {
    if (info) printUpdate(info);
  });

  const tokens = await obtainTokens(cfg);

  if (flags.foreground) {
    await offerAutostart();
    const service = await (await import("./service")).runService(cfg, tokens, {
      debug: flags.debug,
      logFd,
      onConnection: (connected) =>
        console.log(
          connected ? out.green("✓ Connected to Gather.") : out.yellow("Disconnected from Gather; reconnecting..."),
        ),
    });
    onFatal = (e) => {
      console.error(err.red(`Unexpected error: ${describeError(e)}`));
      void service.shutdown("Unexpected error", 1);
    };
    return undefined;
  }

  console.log(out.dim("Connecting to Gather..."));
  let pid: number;
  try {
    pid = await spawnDaemon({ tokens, cfg, debug: flags.debug }, logFd);
  } catch (e) {
    throw new UserError(`Could not start in the background: ${describeError(e)}. See ${logPath()}`);
  }
  console.log(out.green("✓ Running in background ") + out.dim(`(PID ${pid})`));
  console.log(`  ${out.dim("Logs:  ")} ${logPath()}`);
  console.log(`  ${out.dim("Status:")} ${out.cyan(`${APP_NAME} --status`)}`);
  console.log(`  ${out.dim("Stop:  ")} ${out.cyan(`${APP_NAME} --stop`)}`);
  await Promise.race([update, sleep(UPDATE_NOTICE_WAIT_MS)]);
  await offerAutostart(); // first run only
  return 0;
}

async function main(argv: readonly string[]): Promise<Outcome> {
  const flags = parseFlags(argv);
  switch (flags.info) {
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "version":
      console.log(`${APP_NAME} ${VERSION}`);
      return 0;
    case "config-path":
      console.log(configPath());
      return 0;
  }

  if (process.env.GSS_DAEMON === "1") return runDaemon();

  const oneShot = await runOneShot(flags);
  if (oneShot !== "none") return oneShot;
  return start(flags);
}

function handleError(e: unknown): void {
  if (e instanceof UserError) {
    if (e.message) console.error(err.red(e.message));
    if (e instanceof UsageError) process.stderr.write(`\n${HELP}`);
    process.exit(e.exitCode);
  }
  onFatal(e);
}

process.on("unhandledRejection", (reason) => onFatal(reason));
process.on("uncaughtException", (e) => onFatal(e));

main(process.argv.slice(2)).then((code) => {
  if (code !== undefined) process.exit(code);
}, handleError);

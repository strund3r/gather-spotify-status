// SPDX-License-Identifier: GPL-3.0-or-later
// Command-line flags. Pure: no I/O, so it can be unit-tested.
import { APP_NAME } from "./constants";
import { UsageError } from "./errors";
import { DEFAULT_LOG_LINES } from "./logs";
import { isSettingKey, SETTING_KEYS, type SettingKey } from "./settings";
import { VERSION } from "./version";

export const HELP = `${APP_NAME} v${VERSION} - set your Gather status to what you're playing on Spotify

Usage: ${APP_NAME} [options]

By default it logs in to Spotify (or reuses your saved login) and keeps running in the background.

Running instance:
  --status            Show whether it's running, what it's showing, where the logs are
  --stop              Stop it (and clear your Gather status)
  --pause / --resume  Temporarily clear your status / show it again
  --logs [-n N]       Show the last N log lines (default ${DEFAULT_LOG_LINES}) and follow new ones
  --foreground        Stay in this terminal instead of going to the background (Ctrl+C to stop)
  --debug             Verbose logging (every poll and status update)

Settings (applied immediately to a running instance):
  --get [key]         Show settings
  --set key=value     Change a setting, e.g. --set statusFormat="{artist} – {track}"
                      Keys: ${SETTING_KEYS.join(", ")}

Setup:
  --setup             Re-run the setup wizard (press Enter to keep current values)
  --set-config KEY[=VALUE]  Change a connection credential (prompts if =VALUE is omitted)
  --autostart on|off|status  Start automatically when you log in to your computer
  --logout            Forget the saved Spotify login
  --reset             Delete saved config and secrets, and prompt again
  --config-path       Print the config file location
  --readme            Open the README (PDF) with setup instructions
  --check-update      Check for a newer version
  --insecure          Disable TLS verification without asking (only if TLS checks fail)
  --no-install        Run this copy as-is; don't install/upgrade it to the per-user bin folder
  -v, --version       Print the version
  -h, --help          Show this help

Environment variables (override the config file; never stored):
  GATHER_API_KEY, GATHER_SPACE_ID, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
  NODE_EXTRA_CA_CERTS   Extra root CA (PEM) to trust, e.g. a corporate proxy CA
  GSS_INSECURE_TLS=1    Same as --insecure
`;

export type AutostartAction = "on" | "off" | "status";

export interface Flags {
  /** -h / -v / --config-path: print and exit; the rest of the command line is ignored. */
  info?: "help" | "version" | "config-path";
  reset: boolean;
  insecure: boolean;
  stop: boolean;
  status: boolean;
  foreground: boolean;
  noInstall: boolean;
  readme: boolean;
  debug: boolean;
  pause: boolean;
  resume: boolean;
  logout: boolean;
  setup: boolean;
  setConfig: string[];
  checkUpdate: boolean;
  /** Bare --autostart: started by the login entry. */
  autostartRun: boolean;
  autostartAction?: AutostartAction;
  logs?: number;
  get?: SettingKey | "all";
  set: string[];
}

const BOOLEAN_FLAGS = {
  "--reset": "reset",
  "--insecure": "insecure",
  "--stop": "stop",
  "--status": "status",
  "--foreground": "foreground",
  "--no-install": "noInstall",
  "--readme": "readme",
  "--debug": "debug",
  "--pause": "pause",
  "--resume": "resume",
  "--logout": "logout",
  "--setup": "setup",
  "--check-update": "checkUpdate",
} as const satisfies Record<string, keyof Flags>;

const INFO_FLAGS: Record<string, NonNullable<Flags["info"]>> = {
  "-h": "help",
  "--help": "help",
  "-v": "version",
  "--version": "version",
  "--config-path": "config-path",
};

function isBooleanFlag(arg: string): arg is keyof typeof BOOLEAN_FLAGS {
  return Object.hasOwn(BOOLEAN_FLAGS, arg);
}

function isAutostartAction(s: string | undefined): s is AutostartAction {
  return s === "on" || s === "off" || s === "status";
}

/** Parse argv (without node/script). Throws UsageError on invalid input. */
export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    reset: false,
    insecure: false,
    stop: false,
    status: false,
    foreground: false,
    noInstall: false,
    readme: false,
    debug: false,
    pause: false,
    resume: false,
    logout: false,
    setup: false,
    setConfig: [],
    checkUpdate: false,
    autostartRun: false,
    set: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    const info = INFO_FLAGS[arg];
    if (info) return { ...flags, info };
    if (isBooleanFlag(arg)) {
      flags[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }
    switch (arg) {
      case "--autostart":
        if (isAutostartAction(next)) {
          flags.autostartAction = next;
          i++;
        } else {
          flags.autostartRun = true;
        }
        break;
      case "--logs":
        flags.logs = DEFAULT_LOG_LINES;
        break;
      case "-n": {
        const n = Number(next);
        if (next === undefined || !Number.isInteger(n) || n < 0) throw new UsageError("-n needs a number of lines");
        flags.logs = n;
        i++;
        break;
      }
      case "--get":
        if (next !== undefined && !next.startsWith("-")) {
          if (!isSettingKey(next)) {
            throw new UsageError(`Unknown setting "${next}". Valid settings: ${SETTING_KEYS.join(", ")}`);
          }
          flags.get = next;
          i++;
        } else {
          flags.get = "all";
        }
        break;
      case "--set":
        if (next === undefined) throw new UsageError("--set needs key=value");
        flags.set.push(next);
        i++;
        break;
      case "--set-config":
        if (next === undefined) throw new UsageError("--set-config needs KEY or KEY=VALUE");
        flags.setConfig.push(next);
        i++;
        break;
      default:
        throw new UsageError(`Unknown option: ${arg}`);
    }
  }
  return flags;
}

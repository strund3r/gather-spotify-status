// SPDX-License-Identifier: GPL-3.0-or-later
// User settings (status format, privacy rules, ...), stored under "settings" in config.json.
// Changed with `--set key=value`, listed with `--get`.
import { errorMessage, isRecord } from "./util";
import { parseWorkHours } from "./workhours";

export interface Settings {
  statusFormat: string;
  podcastFormat: string;
  musicEmoji: string;
  podcastEmoji: string;
  maxLength: number;
  blockArtists: string[];
  workHours: string;
  skipPrivateSession: boolean;
  debug: boolean;
}

export type SettingKey = keyof Settings;

export const DEFAULTS: Readonly<Settings> = {
  statusFormat: "{artist} ∙ {track} (Spotify)",
  podcastFormat: "Listening to a podcast on Spotify",
  musicEmoji: "🎶",
  podcastEmoji: "🎙️",
  maxLength: 100,
  blockArtists: [],
  workHours: "off",
  skipPrivateSession: true,
  debug: false,
};

const MAX_LENGTH_LIMIT = 1000;

interface Spec<K extends SettingKey> {
  describe: string;
  /** Parse user input (or a stored value turned into a string). Throws Error with a readable message. */
  parse(raw: string): Settings[K];
}

function parseBool(raw: string): boolean {
  if (/^(true|yes|on|1)$/i.test(raw.trim())) return true;
  if (/^(false|no|off|0)$/i.test(raw.trim())) return false;
  throw new Error(`expected true or false, got "${raw}"`);
}

function nonEmpty(raw: string, what: string): string {
  const v = raw.trim();
  if (!v) throw new Error(`${what} cannot be empty`);
  return v;
}

const SPECS: { [K in SettingKey]: Spec<K> } = {
  statusFormat: {
    describe: "Status text for music. Placeholders: {artist} {artists} {track} {album}",
    parse: (raw) => nonEmpty(raw, "statusFormat"),
  },
  podcastFormat: {
    describe: "Status text for podcasts. Placeholders: {show} {episode}",
    parse: (raw) => nonEmpty(raw, "podcastFormat"),
  },
  musicEmoji: {
    describe: "Emoji shown with music (empty for none)",
    parse: (raw) => raw.trim(),
  },
  podcastEmoji: {
    describe: "Emoji shown with podcasts (empty for none)",
    parse: (raw) => raw.trim(),
  },
  maxLength: {
    describe: "Truncate the status text to this many characters (0 = no limit)",
    parse: (raw) => {
      const n = Number(raw.trim());
      if (!Number.isInteger(n) || n < 0 || n > MAX_LENGTH_LIMIT) {
        throw new Error(`expected a whole number 0-${MAX_LENGTH_LIMIT}, got "${raw}"`);
      }
      return n;
    },
  },
  blockArtists: {
    describe: "Comma-separated artists that never show (status is cleared). Empty = none",
    parse: (raw) =>
      raw
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
  },
  workHours: {
    describe: 'Only show a status during these hours, e.g. "Mon-Fri 09:00-18:00", or "off"',
    parse: (raw) => {
      const v = raw.trim() || "off";
      parseWorkHours(v); // throws on invalid input
      return /^off$/i.test(v) ? "off" : v;
    },
  },
  skipPrivateSession: {
    describe: "Don't show anything while a Spotify private session is on",
    parse: parseBool,
  },
  debug: {
    describe: "Verbose logging (every poll and status update) in the log file",
    parse: parseBool,
  },
};

export const SETTING_KEYS = Object.keys(SPECS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key);
}

function assign<K extends SettingKey>(target: Settings, key: K, raw: string): void {
  target[key] = SPECS[key].parse(raw);
}

/**
 * Merge stored settings over defaults. Invalid stored values fall back to the default and are reported
 * through `onInvalid` (e.g. a hand-edited config.json).
 */
export function normalizeSettings(raw: unknown, onInvalid?: (key: SettingKey, message: string) => void): Settings {
  const result: Settings = { ...DEFAULTS, blockArtists: [...DEFAULTS.blockArtists] };
  if (!isRecord(raw)) return result;
  for (const key of SETTING_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    try {
      assign(result, key, Array.isArray(v) ? v.join(",") : String(v));
    } catch (e) {
      onInvalid?.(key, errorMessage(e)); // keep the default
    }
  }
  return result;
}

/** Parse "key=value" from --set. Throws Error with a readable message. */
export function parseSetArg(arg: string): { key: SettingKey; value: Settings[SettingKey] } {
  const eq = arg.indexOf("=");
  if (eq <= 0) throw new Error(`expected key=value, got "${arg}"`);
  const key = arg.slice(0, eq).trim();
  if (!isSettingKey(key)) {
    throw new Error(`unknown setting "${key}". Valid settings: ${SETTING_KEYS.join(", ")}`);
  }
  try {
    return { key, value: SPECS[key].parse(arg.slice(eq + 1)) };
  } catch (e) {
    throw new Error(`${key}: ${errorMessage(e)}`);
  }
}

function displayValue(v: Settings[SettingKey]): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
  if (v === "") return "(none)";
  return String(v);
}

export interface SettingRow {
  key: SettingKey;
  value: string;
  isDefault: boolean;
  describe: string;
}

/** Lines for `--get`: key = value, marking values that are still the default. */
export function describeSettings(s: Settings, only?: SettingKey): SettingRow[] {
  return (only ? [only] : SETTING_KEYS).map((key) => ({
    key,
    value: displayValue(s[key]),
    isDefault: JSON.stringify(s[key]) === JSON.stringify(DEFAULTS[key]),
    describe: SPECS[key].describe,
  }));
}

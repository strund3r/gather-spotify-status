// SPDX-License-Identifier: GPL-3.0-or-later
// config.json: the 4 connection values (secrets in the OS keychain when available), the "settings"
// section, and the saved Spotify refresh token.
import fs from "node:fs";
import path from "node:path";
import { err, out } from "./colors";
import { APP_NAME } from "./constants";
import { UserError } from "./errors";
import { readJson, removeFile, writePrivateJson } from "./fsutil";
import { configPath } from "./paths";
import { ask } from "./prompt";
import { deleteSecret, getSecret, keychainName, storeSecret } from "./secrets";
import { normalizeSettings, type SettingKey, type Settings } from "./settings";
import { errorMessage, isRecord } from "./util";

export interface Config {
  GATHER_API_KEY: string;
  GATHER_SPACE_ID: string;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
}

type ConfigKey = keyof Config;

interface FieldSpec {
  key: ConfigKey;
  label: string;
  hint: string;
  secret: boolean;
}

const FIELDS: FieldSpec[] = [
  {
    key: "GATHER_API_KEY",
    label: "Gather API key",
    hint: "Generate one at https://gather.town/apiKeys",
    secret: true,
  },
  {
    key: "GATHER_SPACE_ID",
    label: "Gather space ID",
    hint: "From the space URL: app.gather.town/app/<spaceId>/<Space Name>  ->  enter <spaceId>/<Space Name>",
    secret: false,
  },
  {
    key: "SPOTIFY_CLIENT_ID",
    label: "Spotify client ID",
    hint: "From your app at https://developer.spotify.com/dashboard (see README)",
    secret: false,
  },
  {
    key: "SPOTIFY_CLIENT_SECRET",
    label: "Spotify client secret",
    hint: "Same app -> Settings -> View client secret",
    secret: true,
  },
];

const SECRET_FIELDS = FIELDS.filter((f) => f.secret);
const REFRESH_TOKEN_KEY = "SPOTIFY_REFRESH_TOKEN";

/** Where the secrets live: the OS keychain, or (fallback) the config file itself. */
export type SecretStorage = "keychain" | "file";

type RawConfig = Record<string, unknown>;

interface ConfigFile {
  values: Partial<Config>;
  secretStorage?: SecretStorage;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The connection values in config.json. Throws UserError if the file exists but is corrupt. */
function readConfigFile(file: string): ConfigFile {
  if (!fs.existsSync(file)) return { values: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UserError(`Could not parse ${file} (${errorMessage(e)}). Run with --reset to recreate it.`);
  }
  if (!isRecord(parsed)) throw new UserError(`${file} is not a JSON object. Run with --reset to recreate it.`);
  const values: Partial<Config> = {};
  for (const { key } of FIELDS) {
    const v = nonEmptyString(parsed[key]);
    if (v) values[key] = v;
  }
  const storage =
    parsed.secretStorage === "keychain" || parsed.secretStorage === "file" ? parsed.secretStorage : undefined;
  return { values, secretStorage: storage };
}

/** The whole config.json object (other sections like "settings" included); {} if missing or unreadable. */
function readRaw(file = configPath()): RawConfig {
  const parsed = readJson(file);
  return isRecord(parsed) ? parsed : {};
}

function writeRaw(raw: RawConfig, file = configPath()): void {
  writePrivateJson(file, raw, true);
}

/** Update the config fields, keeping other sections. Secrets are only included when storage is "file". */
function writeConfigFile(file: string, values: Partial<Config>, storage: SecretStorage): void {
  const raw = readRaw(file);
  for (const { key, secret } of FIELDS) {
    if (values[key] && (!secret || storage === "file")) raw[key] = values[key];
    else delete raw[key];
  }
  raw.secretStorage = storage;
  if (storage === "keychain") delete raw[REFRESH_TOKEN_KEY];
  writeRaw(raw, file);
}

// ---------------------------------------------------------------------------
// Settings ("settings" section)
// ---------------------------------------------------------------------------

const warnedInvalid = new Set<string>();

export function loadSettings(): Settings {
  return normalizeSettings(readRaw().settings, (key, message) => {
    if (warnedInvalid.has(key)) return;
    warnedInvalid.add(key);
    console.warn(err.yellow(`Ignoring invalid setting ${key} in ${configPath()} (${message}); using the default.`));
  });
}

export function saveSetting(key: SettingKey, value: Settings[SettingKey]): Settings {
  const raw = readRaw();
  raw.settings = { ...(isRecord(raw.settings) ? raw.settings : {}), [key]: value };
  writeRaw(raw);
  return normalizeSettings(raw.settings);
}

// ---------------------------------------------------------------------------
// First-run questions already answered (so they're asked only once)
// ---------------------------------------------------------------------------

const AUTOSTART_ASKED_KEY = "autostartAsked";

export function autostartAsked(): boolean {
  return readRaw()[AUTOSTART_ASKED_KEY] === true;
}

export function markAutostartAsked(): void {
  const raw = readRaw();
  if (raw[AUTOSTART_ASKED_KEY] === true) return;
  raw[AUTOSTART_ASKED_KEY] = true;
  writeRaw(raw);
}

// ---------------------------------------------------------------------------
// Spotify refresh token ("stay logged in"): keychain, or the config file when secrets live there.
// ---------------------------------------------------------------------------

/** "file" if the config says so, or (older configs) if it still holds plaintext secrets. */
function storageOf(raw: RawConfig): SecretStorage {
  if (raw.secretStorage === "file" || raw.secretStorage === "keychain") return raw.secretStorage;
  return SECRET_FIELDS.some((f) => nonEmptyString(raw[f.key])) ? "file" : "keychain";
}

export async function loadRefreshToken(): Promise<string | null> {
  const raw = readRaw();
  if (storageOf(raw) === "file") return nonEmptyString(raw[REFRESH_TOKEN_KEY]) ?? null;
  return getSecret(REFRESH_TOKEN_KEY);
}

/** Returns false if it couldn't be stored (then the next run needs a browser login). */
export async function saveRefreshToken(token: string): Promise<boolean> {
  if (!token || !fs.existsSync(configPath())) return false;
  const raw = readRaw();
  if (storageOf(raw) !== "file") return storeSecret(REFRESH_TOKEN_KEY, token);
  raw[REFRESH_TOKEN_KEY] = token;
  writeRaw(raw);
  return true;
}

export async function deleteRefreshToken(): Promise<void> {
  await deleteSecret(REFRESH_TOKEN_KEY);
  const raw = readRaw();
  if (REFRESH_TOKEN_KEY in raw) {
    delete raw[REFRESH_TOKEN_KEY];
    writeRaw(raw);
  }
}

/** POSIX: if the config dir/file became readable by others, tighten them back to 0700/0600. */
function fixPermissions(file: string): void {
  if (process.platform === "win32") return;
  for (const [p, mode] of [
    [path.dirname(file), 0o700],
    [file, 0o600],
  ] as const) {
    try {
      if ((fs.statSync(p).mode & 0o077) !== 0) {
        fs.chmodSync(p, mode);
        console.warn(err.yellow(`Fixed loose permissions on ${p} (now ${mode.toString(8)}).`));
      }
    } catch {
      // doesn't exist yet
    }
  }
}

/** For --status: where the secrets are stored, if a config exists. Throws UserError if it's corrupt. */
export function secretStorage(): SecretStorage | undefined {
  const { values, secretStorage } = readConfigFile(configPath());
  if (secretStorage) return secretStorage;
  return SECRET_FIELDS.some((f) => values[f.key]) ? "file" : undefined;
}

/** Store all given secrets in the keychain; true only if every one succeeded. */
async function storeAllSecrets(values: Partial<Config>, keys: ConfigKey[]): Promise<boolean> {
  for (const key of keys) {
    const value = values[key];
    if (!value || !(await storeSecret(key, value))) return false;
  }
  return true;
}

function warnKeychainUnavailable(file: string): void {
  console.warn(err.dim(`OS keychain unavailable; secrets stay in ${file} (readable only by you).`));
}

export async function resetConfig(): Promise<void> {
  const file = configPath();
  for (const { key } of SECRET_FIELDS) await deleteSecret(key);
  await deleteSecret(REFRESH_TOKEN_KEY);
  if (removeFile(file)) console.log(`Removed ${file}`);
}

function isComplete(cfg: Partial<Config>): cfg is Config {
  return FIELDS.every((f) => !!cfg[f.key]);
}

/**
 * Resolve config from (1) env vars, (2) OS keychain (secrets) / config file, (3) interactive prompt.
 * Secrets are kept in the OS keychain when available; old plaintext secrets in the file are migrated.
 * Env-provided values are never stored.
 */
export async function loadConfig(): Promise<Config> {
  const file = configPath();
  fixPermissions(file);
  const { values: fromFile, secretStorage: storedIn } = readConfigFile(file);
  let storage: SecretStorage | undefined = storedIn;

  // Migrate plaintext secrets left in the file (hand-written config, or an earlier keychain failure).
  const fileSecretKeys = SECRET_FIELDS.map((f) => f.key).filter((k) => fromFile[k]);
  if (fileSecretKeys.length > 0) {
    if (await storeAllSecrets(fromFile, fileSecretKeys)) {
      const fileRefreshToken = nonEmptyString(readRaw(file)[REFRESH_TOKEN_KEY]);
      if (fileRefreshToken) await storeSecret(REFRESH_TOKEN_KEY, fileRefreshToken);
      writeConfigFile(file, fromFile, "keychain");
      storage = "keychain";
      const names = SECRET_FIELDS.filter((f) => fileSecretKeys.includes(f.key)).map((f) => f.label);
      console.log(
        out.green(`✓ Moved ${names.join(" and ")} to ${keychainName()}.`) +
          out.dim(` (${file} no longer contains them)`),
      );
    } else {
      storage = "file";
      if (storedIn !== "file") writeConfigFile(file, fromFile, "file"); // record the fallback
      warnKeychainUnavailable(file);
    }
  }

  const cfg: Partial<Config> = {};
  for (const { key, secret } of FIELDS) {
    const fromEnv = process.env[key]?.trim();
    const fromKeychain = secret && storage === "keychain" ? ((await getSecret(key)) ?? undefined) : undefined;
    cfg[key] = fromEnv || fromFile[key] || fromKeychain;
  }
  if (isComplete(cfg)) return cfg;

  const missing = FIELDS.filter((f) => !cfg[f.key]);
  if (!process.stdin.isTTY) {
    throw new UserError(
      `Missing configuration: ${missing.map((f) => f.key).join(", ")}\n` +
        `Run ${APP_NAME} in an interactive terminal to be prompted, or set these environment variables.`,
    );
  }

  console.log(`${out.bold("First-time setup.")} ${out.dim(`Values will be saved to ${file}`)}\n`);
  for (const field of missing) {
    console.log(`${out.bold(field.label)}: ${out.dim(field.hint)}`);
    let value = "";
    while (!value) {
      value = (await ask(`  ${field.key}: `, field.secret)).trim();
      if (!value) console.log(out.yellow("  Value cannot be empty."));
    }
    cfg[field.key] = value;
    console.log();
  }

  // Only persist values that didn't come from env vars, so env-provided secrets are never stored.
  const isFromEnv = (k: ConfigKey) => !!process.env[k]?.trim();
  const toSave: Partial<Config> = { ...fromFile };
  for (const { key } of FIELDS) {
    if (!isFromEnv(key)) toSave[key] = cfg[key];
  }

  const secretKeysToStore = SECRET_FIELDS.map((f) => f.key).filter((k) => !isFromEnv(k) && toSave[k]);
  let newStorage: SecretStorage = "keychain";
  if (secretKeysToStore.length > 0 && !(await storeAllSecrets(toSave, secretKeysToStore))) {
    newStorage = "file";
    warnKeychainUnavailable(file);
  }
  writeConfigFile(file, toSave, newStorage);
  console.log(
    out.green("✓ Saved config") +
      out.dim(` to ${file}`) +
      (newStorage === "keychain" && secretKeysToStore.length > 0 ? out.dim(`; secrets in ${keychainName()}`) : "") +
      "\n",
  );

  if (!isComplete(cfg)) throw new Error("internal: config incomplete after setup");
  return cfg;
}

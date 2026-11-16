// SPDX-License-Identifier: GPL-3.0-or-later
// Update check and self-update: check GitHub for the latest release, download and verify binaries.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { err, out } from "./colors";
import { APP_NAME } from "./constants";
import { stopDaemon } from "./daemon";
import { readJson, writePrivateJson } from "./fsutil";
import { installPath } from "./install";
import { logger } from "./logger";
import { sendDesktopNotification } from "./notify";
import { configDir } from "./paths";
import { runningInstance } from "./pidfile";
import { isCompiledBinary } from "./proc";
import { compareSemver, errorMessage, isRecord } from "./util";
import { VERSION } from "./version";

/** "owner/name" of the GitHub repo that publishes releases. Empty = update check disabled. */
const REPO = "strund3r/gather-spotify-status";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;
const UPDATE_META_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
export const MAX_SUMS_BYTES = 64 * 1024;
export const MAX_BINARY_BYTES = 200 * 1024 * 1024;

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Undocumented GSS_GITHUB_API override, for tests. */
function apiBase(): string {
  return process.env.GSS_GITHUB_API || "https://api.github.com";
}

function sanitizeReleaseWebUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw || hasControlChars(raw)) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

/** Whether a release asset download URL uses HTTPS on a trusted GitHub host (or the test mock origin). */
export function isTrustedAssetUrl(raw: string): boolean {
  if (!raw || hasControlChars(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol === "https:" &&
      (parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com"))
    ) {
      return true;
    }
    if (process.env.GSS_GITHUB_API) {
      return parsed.origin === new URL(apiBase()).origin;
    }
    return false;
  } catch {
    return false;
  }
}

interface Cache {
  checkedAt: number;
  latest?: string;
  url?: string;
  notifiedVersion?: string;
}

function cachePath(): string {
  return path.join(configDir(), "update-check.json");
}

function readCache(): Cache | null {
  const data = readJson(cachePath());
  if (!isRecord(data) || typeof data.checkedAt !== "number") return null;
  return {
    checkedAt: data.checkedAt,
    latest: typeof data.latest === "string" && SEMVER_RE.test(data.latest) ? data.latest : undefined,
    url: sanitizeReleaseWebUrl(data.url) || undefined,
    notifiedVersion:
      typeof data.notifiedVersion === "string" && SEMVER_RE.test(data.notifiedVersion)
        ? data.notifiedVersion
        : undefined,
  };
}

function writeCachePreservingNotified(entry: Omit<Cache, "notifiedVersion">, prevNotified?: string): void {
  writePrivateJson(cachePath(), prevNotified ? { ...entry, notifiedVersion: prevNotified } : entry);
}

export interface UpdateInfo {
  latest: string;
  url: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface LatestRelease {
  latest: string;
  url: string;
  assets: ReleaseAsset[];
}

export interface UpdateCommandOptions {
  repo?: string;
  currentVersion?: string;
  compiled?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  target?: string;
  running?: () => ReturnType<typeof runningInstance>;
  stopRunning?: () => Promise<boolean>;
  restart?: (target: string) => Promise<boolean> | boolean;
}

/** Expected release binary asset filename for a target OS and CPU architecture, or null if unsupported. */
export function releaseAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const osName =
    platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : null;
  if (!osName) return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  if (osName === "windows" && arch !== "x64") return null;
  const ext = osName === "windows" ? ".exe" : "";
  return `${APP_NAME}-v${version}-${osName}-${arch}${ext}`;
}

/** Extract the lowercase SHA-256 hex digest for `assetName` from a `SHA256SUMS` file. */
export function parseSha256Sums(sumsText: string, assetName: string): string | null {
  for (const line of sumsText.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]?.trim() === assetName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

async function fetchLatestRelease(repo: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<LatestRelease | null> {
  const res = await fetch(`${apiBase()}/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": APP_NAME },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!isRecord(data)) return null;

  const assets: ReleaseAsset[] = [];
  if (Array.isArray(data.assets)) {
    for (const a of data.assets) {
      if (
        isRecord(a) &&
        typeof a.name === "string" &&
        typeof a.browser_download_url === "string" &&
        isTrustedAssetUrl(a.browser_download_url)
      ) {
        assets.push({ name: a.name, url: a.browser_download_url });
      }
    }
  }

  const rawTag = typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : "";
  const latest = SEMVER_RE.test(rawTag) ? rawTag : "";

  return {
    latest,
    url: sanitizeReleaseWebUrl(data.html_url),
    assets,
  };
}

async function fetchLatest(repo: string, now: number): Promise<Cache | null> {
  const rel = await fetchLatestRelease(repo);
  if (!rel) return null;
  return { checkedAt: now, latest: rel.latest, url: rel.url };
}

/**
 * Newer release info, or null (up to date, disabled, offline, rate-limited, ...). Never throws.
 * Uses the 24h cache unless `force`.
 */
export async function checkForUpdate(
  opts: { force?: boolean; repo?: string; now?: number; currentVersion?: string } = {},
): Promise<UpdateInfo | null> {
  const repo = opts.repo ?? REPO;
  if (!repo) return null;
  const now = opts.now ?? Date.now();

  let cache = readCache();
  if (opts.force || !cache || now - cache.checkedAt > DAY_MS) {
    const prevNotified = cache?.notifiedVersion;
    try {
      cache = await fetchLatest(repo, now);
      if (!cache) return null;
      writeCachePreservingNotified(cache, prevNotified);
    } catch (e) {
      logger.debug(`update check failed: ${errorMessage(e)}`);
      return null;
    }
  }
  if (cache.latest && SEMVER_RE.test(cache.latest) && compareSemver(cache.latest, opts.currentVersion ?? VERSION) > 0) {
    return { latest: cache.latest, url: cache.url ?? "" };
  }
  return null;
}

export interface NotifyUpdateOptions {
  repo?: string;
  now?: number;
  currentVersion?: string;
  notify?: (title: string, body: string) => boolean;
}

/**
 * Check for a newer release (using the 24h cache) and send a desktop notification at most once
 * per version. Returns true if a notification was sent.
 */
export async function checkAndNotifyUpdate(opts: NotifyUpdateOptions = {}): Promise<boolean> {
  const info = await checkForUpdate({
    repo: opts.repo,
    now: opts.now,
    currentVersion: opts.currentVersion,
  });
  if (!info) return false;

  const cache = readCache();
  if (cache?.notifiedVersion === info.latest) return false;

  const title = `${APP_NAME} v${info.latest} available`;
  const body = `Run '${APP_NAME} --update' to upgrade.`;
  const sent = (opts.notify ?? sendDesktopNotification)(title, body);
  if (!sent) return false;

  writePrivateJson(cachePath(), {
    checkedAt: cache?.checkedAt ?? opts.now ?? Date.now(),
    latest: info.latest,
    url: info.url,
    notifiedVersion: info.latest,
  });
  logger.info(`New version v${info.latest} available (run '${APP_NAME} --update' to upgrade).`);
  return true;
}

export function printUpdate(info: UpdateInfo): void {
  console.log(
    out.cyan(`↑ New version v${info.latest} available — run '${APP_NAME} --update' to upgrade`) +
      (info.url ? out.dim(` (${info.url})`) : ""),
  );
}

/** --check-update */
export async function checkUpdateCommand(): Promise<void> {
  if (!REPO) {
    console.log(out.dim("Update check isn't configured for this build."));
    return;
  }
  const info = await checkForUpdate({ force: true });
  if (info) printUpdate(info);
  else console.log(out.green(`✓ v${VERSION} is the latest version.`) + out.dim(" (or GitHub couldn't be reached)"));
}

function resolveAssetUrl(rel: LatestRelease, repo: string, name: string): string {
  const listed = rel.assets.find((a) => a.name === name)?.url;
  if (listed && isTrustedAssetUrl(listed)) return listed;
  if (process.env.GSS_GITHUB_API) {
    return `${apiBase()}/repos/${repo}/releases/download/v${rel.latest}/${name}`;
  }
  return `https://github.com/${repo}/releases/download/v${rel.latest}/${name}`;
}

async function readResponseBytes(res: Response, maxBytes: number, label: string): Promise<Buffer | null> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    console.error(err.red(`${label} exceeds maximum allowed size (${maxBytes} bytes).`));
    return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    console.error(err.red(`${label} exceeds maximum allowed size (${maxBytes} bytes).`));
    return null;
  }
  return bytes;
}

async function fetchExpectedSha256(sumsUrl: string, assetName: string): Promise<string | null> {
  let sumsRes: Response;
  try {
    sumsRes = await fetch(sumsUrl, {
      headers: { "User-Agent": APP_NAME },
      signal: AbortSignal.timeout(UPDATE_META_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(err.red(`Could not download SHA256SUMS (${errorMessage(e)}).`));
    return null;
  }
  if (!sumsRes.ok) {
    console.error(err.red(`Could not download SHA256SUMS (HTTP ${sumsRes.status}).`));
    return null;
  }
  const sumsBytes = await readResponseBytes(sumsRes, MAX_SUMS_BYTES, "SHA256SUMS");
  if (!sumsBytes) return null;
  const expectedHash = parseSha256Sums(sumsBytes.toString("utf8"), assetName);
  if (!expectedHash) {
    console.error(err.red(`Could not find ${assetName} in SHA256SUMS.`));
    return null;
  }
  return expectedHash;
}

async function downloadAndVerifyBinary(
  assetUrl: string,
  assetName: string,
  expectedHash: string,
): Promise<Buffer | null> {
  let binRes: Response;
  try {
    binRes = await fetch(assetUrl, {
      headers: { "User-Agent": APP_NAME },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(err.red(`Could not download ${assetName} (${errorMessage(e)}).`));
    return null;
  }
  if (!binRes.ok) {
    console.error(err.red(`Could not download ${assetName} (HTTP ${binRes.status}).`));
    return null;
  }
  const bytes = await readResponseBytes(binRes, MAX_BINARY_BYTES, assetName);
  if (!bytes) return null;
  const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    console.error(
      err.red(`✗ Checksum verification failed for ${assetName} (expected ${expectedHash}, got ${actualHash}).`),
    );
    return null;
  }
  return bytes;
}

function replaceBinary(target: string, bytes: Buffer, platform: NodeJS.Platform): boolean {
  const backup = `${target}.old`;
  const tmp = `${target}.new`;
  let movedToBackup = false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    if (platform === "win32" && fs.existsSync(target)) {
      // A running .exe can't be overwritten, but it can be renamed.
      try {
        fs.unlinkSync(backup);
      } catch {
        // no previous .old
      }
      fs.renameSync(target, backup);
      movedToBackup = true;
    }
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // staged binary already moved or never created
    }
    if (movedToBackup) {
      try {
        fs.renameSync(backup, target);
      } catch {
        // best-effort rollback
      }
    }
    console.error(err.red(`Could not install update to ${target}: ${errorMessage(e)}`));
    return false;
  }
}

/** --update: download the latest release binary, verify SHA-256, replace installed binary, and restart daemon if running. */
export async function updateCommand(opts: UpdateCommandOptions = {}): Promise<boolean> {
  const repo = opts.repo ?? REPO;
  if (!repo) {
    console.log(out.dim("Update isn't configured for this build."));
    return false;
  }
  if (!(opts.compiled ?? isCompiledBinary())) {
    console.error(err.red("Cannot self-update when running from source (use 'git pull' instead)."));
    return false;
  }

  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const currentVersion = opts.currentVersion ?? VERSION;
  const home = opts.home ?? os.homedir();
  const target = opts.target ?? installPath(home, platform);

  let rel: LatestRelease | null = null;
  try {
    rel = await fetchLatestRelease(repo, UPDATE_META_TIMEOUT_MS);
  } catch {
    rel = null;
  }
  if (!rel || !SEMVER_RE.test(rel.latest)) {
    console.error(err.red("Could not check for updates from GitHub."));
    return false;
  }

  writeCachePreservingNotified(
    { checkedAt: Date.now(), latest: rel.latest, url: rel.url },
    readCache()?.notifiedVersion,
  );

  if (compareSemver(rel.latest, currentVersion) <= 0) {
    console.log(out.green(`✓ v${currentVersion} is already the latest version.`));
    return true;
  }

  const assetName = releaseAssetName(rel.latest, platform, arch);
  if (!assetName) {
    console.error(err.red(`No prebuilt binary available for ${platform}/${arch}.`));
    return false;
  }

  const sumsUrl = resolveAssetUrl(rel, repo, "SHA256SUMS");
  const assetUrl = resolveAssetUrl(rel, repo, assetName);

  console.log(out.dim(`Downloading v${rel.latest} (${assetName})...`));
  const expectedHash = await fetchExpectedSha256(sumsUrl, assetName);
  if (!expectedHash) return false;

  const bytes = await downloadAndVerifyBinary(assetUrl, assetName, expectedHash);
  if (!bytes) return false;

  const wasRunning = (opts.running ?? runningInstance)();
  if (wasRunning) {
    console.log(out.yellow(`Stopping running v${wasRunning.version} (PID ${wasRunning.pid})...`));
    await (opts.stopRunning ?? stopDaemon)();
  }

  if (!replaceBinary(target, bytes, platform)) return false;

  console.log(out.green(`✓ Updated v${currentVersion} → ${out.bold(`v${rel.latest}`)}`) + out.dim(` (${target})`));

  if (wasRunning) {
    console.log(out.dim("Restarting background service..."));
    if (opts.restart) {
      return await opts.restart(target);
    }
    const res = spawnSync(target, [], {
      stdio: "inherit",
      env: { ...process.env, GSS_INSTALLED: "1" },
    });
    if (res.status !== 0) {
      console.error(err.red(`Updated binary installed, but restarting failed (exit code ${res.status ?? 1}).`));
      return false;
    }
  }
  return true;
}

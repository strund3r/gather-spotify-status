// SPDX-License-Identifier: GPL-3.0-or-later
// Update check: at most once a day, ask GitHub for the latest release and tell the user if it's newer.
// Disabled until REPO is set (the project hasn't settled on a home repo yet).
import path from "node:path";
import { out } from "./colors";
import { APP_NAME } from "./constants";
import { readJson, writePrivateJson } from "./fsutil";
import { logger } from "./logger";
import { configDir } from "./paths";
import { compareSemver, errorMessage, isRecord } from "./util";
import { VERSION } from "./version";

/** "owner/name" of the GitHub repo that publishes releases. Empty = update check disabled. */
const REPO = "strund3r/gather-spotify-status";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;

/** Undocumented GSS_GITHUB_API override, for tests. */
function apiBase(): string {
  return process.env.GSS_GITHUB_API || "https://api.github.com";
}

interface Cache {
  checkedAt: number;
  latest?: string;
  url?: string;
}

function cachePath(): string {
  return path.join(configDir(), "update-check.json");
}

function readCache(): Cache | null {
  const data = readJson(cachePath());
  if (!isRecord(data) || typeof data.checkedAt !== "number") return null;
  return {
    checkedAt: data.checkedAt,
    latest: typeof data.latest === "string" ? data.latest : undefined,
    url: typeof data.url === "string" ? data.url : undefined,
  };
}

export interface UpdateInfo {
  latest: string;
  url: string;
}

async function fetchLatest(repo: string, now: number): Promise<Cache | null> {
  const res = await fetch(`${apiBase()}/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": APP_NAME },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!isRecord(data)) return null;
  return {
    checkedAt: now,
    latest: typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : "",
    url: typeof data.html_url === "string" ? data.html_url : "",
  };
}

/**
 * Newer release info, or null (up to date, disabled, offline, rate-limited, ...). Never throws.
 * Uses the 24h cache unless `force`.
 */
export async function checkForUpdate(
  opts: { force?: boolean; repo?: string; now?: number } = {},
): Promise<UpdateInfo | null> {
  const repo = opts.repo ?? REPO;
  if (!repo) return null;
  const now = opts.now ?? Date.now();

  let cache = readCache();
  if (opts.force || !cache || now - cache.checkedAt > DAY_MS) {
    try {
      cache = await fetchLatest(repo, now);
      if (!cache) return null;
      writePrivateJson(cachePath(), cache);
    } catch (e) {
      logger.debug(`update check failed: ${errorMessage(e)}`);
      return null;
    }
  }
  if (cache.latest && /^\d+\.\d+\.\d+/.test(cache.latest) && compareSemver(cache.latest, VERSION) > 0) {
    return { latest: cache.latest, url: cache.url ?? "" };
  }
  return null;
}

export function printUpdate(info: UpdateInfo): void {
  console.log(out.cyan(`↑ New version v${info.latest} available`) + (info.url ? out.dim(`: ${info.url}`) : ""));
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

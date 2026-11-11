// SPDX-License-Identifier: GPL-3.0-or-later
// Spotify Web API: token refresh, token lifecycle, playback fetch. (Browser login: oauth.ts.)
import querystring from "node:querystring";
import axios from "axios";
import type { Config } from "./config";
import { describeError, isRecord } from "./util";

/** user-read-playback-state: GET /me/player (private-session flag). user-read-currently-playing: fallback endpoint. */
export const SCOPES = "user-read-currently-playing user-read-playback-state";
export const PLAYBACK_STATE_SCOPE = "user-read-playback-state";

const TOKEN_TIMEOUT_MS = 15_000;
const PLAYBACK_TIMEOUT_MS = 10_000;
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;
/** The proactive refresh timer fires this long before expiry… */
const PROACTIVE_LEAD_MS = 5 * 60_000;
/** …but never sooner than this from now. */
const MIN_REFRESH_DELAY_MS = 30_000;
const DEFAULT_EXPIRES_IN_S = 3600;

// Undocumented GSS_SPOTIFY_ACCOUNTS / GSS_SPOTIFY_API overrides so tests can point at a local mock server.
export function accountsBase(): string {
  return process.env.GSS_SPOTIFY_ACCOUNTS || "https://accounts.spotify.com";
}
function apiBase(): string {
  return process.env.GSS_SPOTIFY_API || "https://api.spotify.com";
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
}

export type RefreshResult = { ok: true; tokens: TokenSet } | { ok: false; revoked: boolean; message: string };
export type RefreshOutcome = "ok" | "revoked" | "error";

export function basicAuth(cfg: Config): string {
  return `Basic ${Buffer.from(`${cfg.SPOTIFY_CLIENT_ID}:${cfg.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`;
}

/** POST /api/token (form-encoded, client credentials in the Authorization header). */
export function postToken(cfg: Config, form: Record<string, string>) {
  return axios.post<unknown>(`${accountsBase()}/api/token`, querystring.stringify(form), {
    headers: { Authorization: basicAuth(cfg), "Content-Type": "application/x-www-form-urlencoded" },
    timeout: TOKEN_TIMEOUT_MS,
  });
}

/** Token endpoint JSON → TokenSet. Throws if there's no access token. */
export function toTokenSet(data: unknown, previousRefreshToken?: string, now = Date.now()): TokenSet {
  if (!isRecord(data) || typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Spotify token response has no access_token");
  }
  return {
    accessToken: data.access_token,
    // Spotify may or may not rotate the refresh token; keep the old one if none is returned.
    refreshToken: String(data.refresh_token || previousRefreshToken || ""),
    expiresAt: now + (Number(data.expires_in) || DEFAULT_EXPIRES_IN_S) * 1000,
    scope: typeof data.scope === "string" ? data.scope : "",
  };
}

/** Exchange a refresh token for a fresh access token. `revoked` = the refresh token is no longer valid. */
export async function refreshTokens(cfg: Config, refreshToken: string, now = Date.now()): Promise<RefreshResult> {
  try {
    const res = await postToken(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
    return { ok: true, tokens: toTokenSet(res.data, refreshToken, now) };
  } catch (e) {
    const response = axios.isAxiosError(e) ? e.response : undefined;
    const data: unknown = response?.data;
    const code = isRecord(data) ? data.error : undefined;
    const revoked = response?.status === 400 && (code === "invalid_grant" || code === "invalid_client");
    return { ok: false, revoked, message: describeError(e) };
  }
}

export interface TokenManagerOptions {
  /** Called with the new tokens after every successful refresh (persist the refresh token). */
  onTokens?: (t: TokenSet) => void;
  log?: (msg: string) => void;
  now?: () => number;
  refresh?: (cfg: Config, refreshToken: string, now: number) => Promise<RefreshResult>;
  /** Schedule proactive refreshes (off in tests). */
  schedule?: boolean;
}

/**
 * Holds the tokens. getValidToken() refreshes when the token is (about to be) expired. It compares
 * wall-clock time, so it also does the right thing after the laptop slept past the expiry.
 */
export class TokenManager {
  private tokens: TokenSet;
  private refreshing: Promise<RefreshOutcome> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  revoked = false;

  constructor(
    private readonly cfg: Config,
    tokens: TokenSet,
    private readonly opts: TokenManagerOptions = {},
  ) {
    this.tokens = tokens;
    this.scheduleRefresh();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  hasScope(scope: string): boolean {
    return this.tokens.scope.split(/\s+/).includes(scope);
  }

  get current(): TokenSet {
    return this.tokens;
  }

  /** A usable access token, or null when the login was revoked. */
  async getValidToken(): Promise<string | null> {
    if (this.revoked) return null;
    if (this.now() >= this.tokens.expiresAt - EXPIRY_MARGIN_MS) {
      const r = await this.forceRefresh();
      if (r === "revoked") return null;
      // "error": try the old token anyway; the poller backs off if it fails.
    }
    return this.tokens.accessToken;
  }

  /** Refresh now. Concurrent calls share one request. */
  forceRefresh(): Promise<RefreshOutcome> {
    if (this.revoked) return Promise.resolve("revoked");
    if (!this.refreshing) {
      const doRefresh = this.opts.refresh ?? refreshTokens;
      this.refreshing = doRefresh(this.cfg, this.tokens.refreshToken, this.now())
        .then((r): RefreshOutcome => {
          if (r.ok) {
            this.tokens = r.tokens;
            this.opts.log?.("Refreshed Spotify access token.");
            this.opts.onTokens?.(r.tokens);
            this.scheduleRefresh();
            return "ok";
          }
          if (r.revoked) {
            this.revoked = true;
            this.opts.log?.(`Spotify login is no longer valid (${r.message}).`);
            return "revoked";
          }
          this.opts.log?.(`Could not refresh Spotify token (${r.message}); will retry.`);
          return "error";
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private scheduleRefresh(): void {
    if (this.opts.schedule === false) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(MIN_REFRESH_DELAY_MS, this.tokens.expiresAt - PROACTIVE_LEAD_MS - this.now());
    this.timer = setTimeout(() => void this.forceRefresh(), delay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

export interface FetchResult {
  status: number;
  data: unknown;
  /** Seconds, from the Retry-After header (429). */
  retryAfter?: number;
}

/**
 * GET the playback state. `player` = /me/player (has device.is_private_session),
 * otherwise /me/player/currently-playing. Never throws for HTTP status codes; throws on network errors.
 */
export async function fetchPlayback(accessToken: string, player: boolean): Promise<FetchResult> {
  const path = player ? "/v1/me/player" : "/v1/me/player/currently-playing";
  const res = await axios.get<unknown>(`${apiBase()}${path}`, {
    params: { additional_types: "episode" },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: PLAYBACK_TIMEOUT_MS,
    validateStatus: () => true,
  });
  const retryAfter = Number(res.headers?.["retry-after"]);
  return {
    status: res.status,
    data: res.data,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  };
}

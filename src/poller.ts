// SPDX-License-Identifier: GPL-3.0-or-later
// The Spotify → Gather poll loop: error policy, backoff, change detection, pause, work hours.
// All I/O is injected so the policy can be unit-tested.

import { APP_NAME } from "./constants";
import type { Settings } from "./settings";
import type { FetchResult, RefreshOutcome } from "./spotify";
import { CLEAR, describeStatus, formatStatus, type GatherStatus, parsePlayback, sameStatus } from "./status";
import { errorCode, errorMessage } from "./util";
import { inWorkHours, msUntilWorkHours, parseWorkHours, type WorkHours } from "./workhours";

export interface PollerDeps {
  /** Valid access token, or null when the login was revoked. */
  getToken(): Promise<string | null>;
  forceRefresh(): Promise<RefreshOutcome>;
  /** player = use GET /me/player (private-session aware). */
  fetch(token: string, player: boolean): Promise<FetchResult>;
  send(status: GatherStatus): void;
  settings(): Settings;
  /** Whether the token has the scope needed for GET /me/player. */
  canUsePlayer(): boolean;
  now(): number;
  log(msg: string): void;
  debug(msg: string): void;
}

export const POLL_MS = 5000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60000;
const FORBIDDEN_DELAY_MS = 5 * 60000;
const DEFAULT_RETRY_AFTER_S = 30;
const RESEND_MS = 10 * 60000;
/** A tick this much later than scheduled means the machine slept (or the process was stopped). */
const SLEEP_DETECT_SLACK_MS = 30_000;
/** Outside work hours: re-check at least this often (and at most this often). */
const WORK_HOURS_MAX_WAIT_MS = 60_000;
const WORK_HOURS_MIN_WAIT_MS = 1000;

export interface PollerState {
  paused: boolean;
  /** Spotify login revoked: polling stopped until the user logs in again. */
  sessionExpired: boolean;
  outsideWorkHours: boolean;
  lastStatus?: GatherStatus;
  lastSentAt: number;
  consecutiveFailures: number;
  /** Epoch ms of the next scheduled poll when backing off, else 0. */
  backoffUntil: number;
  lastError?: string;
}

export class Poller {
  state: PollerState = {
    paused: false,
    sessionExpired: false,
    outsideWorkHours: false,
    lastSentAt: 0,
    consecutiveFailures: 0,
    backoffUntil: 0,
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastTickAt = 0;
  private lastDelay = POLL_MS;
  private playerDisabled = false;
  private forbiddenLogged = false;

  constructor(private deps: PollerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  pause(): void {
    this.state.paused = true;
    this.sendIfChanged(CLEAR, true);
  }

  resume(): void {
    this.state.paused = false;
    this.resendSoon();
  }

  /** Force the next poll to resend the status (e.g. after a Gather reconnect) and poll right away. */
  resendSoon(): void {
    this.state.lastStatus = undefined;
    if (this.running) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.lastDelay = ms;
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop(): Promise<void> {
    const now = this.deps.now();
    // A tick far later than scheduled means the machine was asleep (or the process stopped).
    if (this.lastTickAt && now - this.lastTickAt > this.lastDelay * 2 + SLEEP_DETECT_SLACK_MS) {
      this.deps.log(`Resumed after ${Math.round((now - this.lastTickAt) / 1000)}s pause (sleep?).`);
    }
    this.lastTickAt = now;
    let next: number | null;
    try {
      next = await this.tick();
    } catch (e) {
      this.deps.log(`Unexpected error in poll loop: ${errorMessage(e)}`);
      next = this.failureDelay("unexpected error");
    }
    if (next !== null) this.schedule(next);
    else this.running = false;
  }

  /** One poll. Returns ms until the next poll, or null to stop polling. Exposed for tests. */
  async tick(retried = false): Promise<number | null> {
    const s = this.deps.settings();
    if (this.state.paused) return POLL_MS;

    // Work hours: outside → clear and sleep until the window opens (re-check at least every minute).
    let hours: WorkHours | null = null;
    try {
      hours = parseWorkHours(s.workHours);
    } catch {
      hours = null; // settings are validated on --set; treat a bad hand-edited value as "off"
    }
    const now = new Date(this.deps.now());
    if (!inWorkHours(now, hours)) {
      if (!this.state.outsideWorkHours) this.deps.log("Outside work hours; status cleared.");
      this.state.outsideWorkHours = true;
      this.sendIfChanged(CLEAR);
      return Math.min(Math.max(msUntilWorkHours(now, hours), WORK_HOURS_MIN_WAIT_MS), WORK_HOURS_MAX_WAIT_MS);
    }
    if (this.state.outsideWorkHours) this.deps.log("Work hours started.");
    this.state.outsideWorkHours = false;

    const token = await this.deps.getToken();
    if (!token) return this.expire();

    const usePlayer = s.skipPrivateSession && !this.playerDisabled && this.deps.canUsePlayer();
    let res: FetchResult;
    try {
      res = await this.deps.fetch(token, usePlayer);
    } catch (e) {
      return this.failureDelay(`network: ${errorCode(e) || errorMessage(e)}`);
    }

    switch (true) {
      case res.status === 200: {
        const status = formatStatus(parsePlayback(res.data), s);
        this.deps.debug(`poll 200 → ${describeStatus(status)}`);
        this.success();
        this.sendIfChanged(status);
        return POLL_MS;
      }
      case res.status === 204: {
        this.deps.debug("poll 204 → nothing playing");
        this.success();
        this.sendIfChanged(CLEAR);
        return POLL_MS;
      }
      case res.status === 401: {
        if (retried) return this.failureDelay("HTTP 401 after token refresh");
        const r = await this.deps.forceRefresh();
        if (r === "revoked") return this.expire();
        if (r === "error") return this.failureDelay("HTTP 401, token refresh failed");
        return this.tick(true);
      }
      case res.status === 403: {
        if (usePlayer) {
          // Token without the playback-state scope (old login): fall back to currently-playing.
          this.playerDisabled = true;
          this.deps.log("No access to playback state; private-session detection off until you log in again.");
          return retried ? POLL_MS : this.tick(true);
        }
        if (!this.forbiddenLogged) {
          this.deps.log(
            "Spotify returned 403: your account may not be allowlisted in the Spotify app (User Management), or the app owner lacks Premium.",
          );
          this.forbiddenLogged = true;
        }
        this.state.lastError = "HTTP 403";
        this.state.backoffUntil = this.deps.now() + FORBIDDEN_DELAY_MS;
        return FORBIDDEN_DELAY_MS;
      }
      case res.status === 429: {
        const wait = (res.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000;
        this.deps.log(`Spotify rate limit (429); waiting ${Math.round(wait / 1000)}s.`);
        this.state.lastError = "HTTP 429";
        this.state.backoffUntil = this.deps.now() + wait;
        return wait;
      }
      default:
        return this.failureDelay(`HTTP ${res.status}`);
    }
  }

  private success(): void {
    if (this.state.consecutiveFailures > 0) this.deps.log("Spotify connection recovered.");
    this.state.consecutiveFailures = 0;
    this.state.backoffUntil = 0;
    this.state.lastError = undefined;
  }

  /** Exponential backoff 5s, 10s, 20s … capped at 5 min. Never exits. */
  private failureDelay(reason: string): number {
    this.state.consecutiveFailures++;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.state.consecutiveFailures - 1), BACKOFF_MAX_MS);
    this.state.lastError = reason;
    this.state.backoffUntil = this.deps.now() + delay;
    this.deps.log(`Spotify request failed (${reason}); retrying in ${Math.round(delay / 1000)}s.`);
    return delay;
  }

  private expire(): null {
    if (!this.state.sessionExpired) {
      this.state.sessionExpired = true;
      this.sendIfChanged(CLEAR, true);
      this.deps.log(`Spotify session expired. Run ${APP_NAME} again to log in.`);
    }
    return null;
  }

  /** Send only when the status changed, or as a periodic safety-net resend. */
  private sendIfChanged(status: GatherStatus, force = false): void {
    const now = this.deps.now();
    if (!force && sameStatus(this.state.lastStatus, status) && now - this.state.lastSentAt < RESEND_MS) {
      return;
    }
    this.deps.send(status);
    this.deps.debug(`sent status: ${describeStatus(status)}`);
    this.state.lastStatus = status;
    this.state.lastSentAt = now;
  }
}

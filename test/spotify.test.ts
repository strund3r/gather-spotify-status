import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { type RefreshResult, TokenManager, type TokenSet } from "../src/spotify";

const cfg: Config = {
  GATHER_API_KEY: "g",
  GATHER_SPACE_ID: "s/x",
  SPOTIFY_CLIENT_ID: "id",
  SPOTIFY_CLIENT_SECRET: "sec",
};
const tokens = (now: number, over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: "a1",
  refreshToken: "r1",
  expiresAt: now + 3600000,
  scope: "user-read-currently-playing user-read-playback-state",
  ...over,
});

function setup(results: RefreshResult[]) {
  let now = 1_000_000;
  const calls: string[] = [];
  const persisted: string[] = [];
  const tm = new TokenManager(cfg, tokens(now), {
    now: () => now,
    schedule: false,
    refresh: async (_c, refreshToken) => {
      calls.push(refreshToken);
      return results.shift() ?? { ok: false, revoked: false, message: "no more" };
    },
    onTokens: (t) => persisted.push(t.refreshToken),
  });
  return { tm, calls, persisted, advance: (ms: number) => (now += ms), now: () => now };
}

describe("TokenManager", () => {
  test("valid token: no refresh", async () => {
    const t = setup([]);
    expect(await t.tm.getValidToken()).toBe("a1");
    expect(t.calls.length).toBe(0);
  });

  test("after a long sleep the expired token is refreshed before use; rotated refresh token persisted", async () => {
    const t = setup([{ ok: true, tokens: tokens(0, { accessToken: "a2", refreshToken: "r2", expiresAt: 0 }) }]);
    t.advance(2 * 3600000); // laptop slept 2h
    // expiresAt in the result is computed by refreshTokens; emulate a fresh one:
    expect(await t.tm.getValidToken()).toBe("a2");
    expect(t.calls).toEqual(["r1"]);
    expect(t.persisted).toEqual(["r2"]);
  });

  test("refreshes slightly before expiry (60s margin)", async () => {
    const t = setup([{ ok: true, tokens: tokens(0, { accessToken: "a2", expiresAt: Number.MAX_SAFE_INTEGER }) }]);
    t.advance(3600000 - 30000);
    expect(await t.tm.getValidToken()).toBe("a2");
  });

  test("revoked → null from then on", async () => {
    const t = setup([{ ok: false, revoked: true, message: "invalid_grant" }]);
    expect(await t.tm.forceRefresh()).toBe("revoked");
    expect(await t.tm.getValidToken()).toBeNull();
    expect(t.tm.revoked).toBe(true);
  });

  test("transient refresh error keeps the old token", async () => {
    const t = setup([{ ok: false, revoked: false, message: "ETIMEDOUT" }]);
    t.advance(2 * 3600000);
    expect(await t.tm.getValidToken()).toBe("a1");
    expect(t.tm.revoked).toBe(false);
  });

  test("concurrent refreshes share one request", async () => {
    const t = setup([{ ok: true, tokens: tokens(0, { accessToken: "a2", expiresAt: Number.MAX_SAFE_INTEGER }) }]);
    await Promise.all([t.tm.forceRefresh(), t.tm.forceRefresh(), t.tm.forceRefresh()]);
    expect(t.calls.length).toBe(1);
  });

  test("scope check", () => {
    const t = setup([]);
    expect(t.tm.hasScope("user-read-playback-state")).toBe(true);
    expect(t.tm.hasScope("user-modify-playback-state")).toBe(false);
  });
});

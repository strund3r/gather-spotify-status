import { describe, expect, test } from "bun:test";
import { POLL_MS, Poller, type PollerDeps } from "../src/poller";
import { DEFAULTS, type Settings } from "../src/settings";
import type { FetchResult } from "../src/spotify";
import type { GatherStatus } from "../src/status";

const playing = { is_playing: true, currently_playing_type: "track", item: { name: "Song", artists: [{ name: "A" }] } };

function setup(
  responses: (FetchResult | Error)[],
  { settings: settingsOver, ...over }: Partial<Omit<PollerDeps, "settings">> & { settings?: Partial<Settings> } = {},
) {
  const sent: GatherStatus[] = [];
  const logs: string[] = [];
  const fetchCalls: { token: string; player: boolean }[] = [];
  let now = new Date(2026, 10, 10, 12, 0).getTime(); // Tuesday noon
  let refreshes = 0;
  const settings: Settings = { ...DEFAULTS, ...(settingsOver ?? {}) };
  const deps: PollerDeps = {
    getToken: async () => "tok",
    forceRefresh: async () => {
      refreshes++;
      return "ok";
    },
    fetch: async (token, player) => {
      fetchCalls.push({ token, player });
      const r = responses.shift() ?? { status: 204, data: "" };
      if (r instanceof Error) throw r;
      return r;
    },
    send: (s) => sent.push(s),
    settings: () => settings,
    canUsePlayer: () => true,
    now: () => now,
    log: (m) => logs.push(m),
    debug: () => {},
    ...over,
  };
  const poller = new Poller(deps);
  return { poller, sent, logs, fetchCalls, refreshes: () => refreshes, advance: (ms: number) => (now += ms) };
}

describe("Poller error policy", () => {
  test("200 sends the status; unchanged status isn't resent", async () => {
    const t = setup([
      { status: 200, data: playing },
      { status: 200, data: playing },
    ]);
    expect(await t.poller.tick()).toBe(POLL_MS);
    expect(await t.poller.tick()).toBe(POLL_MS);
    expect(t.sent).toEqual([{ emoji: "🎶", text: "A ∙ Song (Spotify)" }]);
  });

  test("unchanged status is resent after 10 minutes as a safety net", async () => {
    const t = setup([
      { status: 200, data: playing },
      { status: 200, data: playing },
    ]);
    await t.poller.tick();
    t.advance(11 * 60000);
    await t.poller.tick();
    expect(t.sent.length).toBe(2);
  });

  test("204 clears", async () => {
    const t = setup([
      { status: 200, data: playing },
      { status: 204, data: "" },
    ]);
    await t.poller.tick();
    await t.poller.tick();
    expect(t.sent[1]).toEqual({ emoji: "", text: "" });
  });

  test("401 → refresh → retry once", async () => {
    const t = setup([
      { status: 401, data: {} },
      { status: 200, data: playing },
    ]);
    expect(await t.poller.tick()).toBe(POLL_MS);
    expect(t.refreshes()).toBe(1);
    expect(t.sent.length).toBe(1);
  });

  test("401 twice → backoff, never exits", async () => {
    const t = setup([
      { status: 401, data: {} },
      { status: 401, data: {} },
    ]);
    expect(await t.poller.tick()).toBe(5000);
    expect(t.poller.state.consecutiveFailures).toBe(1);
  });

  test("revoked login → clear status and stop polling (null)", async () => {
    const t = setup([{ status: 401, data: {} }], { forceRefresh: async () => "revoked" });
    expect(await t.poller.tick()).toBeNull();
    expect(t.poller.state.sessionExpired).toBe(true);
    expect(t.sent).toEqual([{ emoji: "", text: "" }]);
    expect(t.logs.join("\n")).toMatch(/expired/);
  });

  test("no token (revoked earlier) → stop", async () => {
    const t = setup([], { getToken: async () => null });
    expect(await t.poller.tick()).toBeNull();
  });

  test("429 honors Retry-After, default 30s", async () => {
    const t = setup([
      { status: 429, data: {}, retryAfter: 7 },
      { status: 429, data: {} },
    ]);
    expect(await t.poller.tick()).toBe(7000);
    expect(await t.poller.tick()).toBe(30000);
  });

  test("network errors and 5xx back off exponentially, capped at 5 min, reset on success", async () => {
    const errs: (FetchResult | Error)[] = [
      new Error("ECONNRESET"),
      { status: 500, data: {} },
      { status: 502, data: {} },
      ...Array(10).fill({ status: 503, data: {} }),
      { status: 200, data: playing },
    ];
    const t = setup(errs);
    const delays: (number | null)[] = [];
    for (let i = 0; i < 13; i++) delays.push(await t.poller.tick());
    expect(delays.slice(0, 4)).toEqual([5000, 10000, 20000, 40000]);
    expect(Math.max(...(delays as number[]))).toBe(300000);
    expect(await t.poller.tick()).toBe(POLL_MS);
    expect(t.poller.state.consecutiveFailures).toBe(0);
    expect(t.logs.join("\n")).toMatch(/recovered/);
  });

  test("403 on /me/player (missing scope) → falls back to currently-playing", async () => {
    const t = setup([
      { status: 403, data: {} },
      { status: 200, data: playing },
    ]);
    expect(await t.poller.tick()).toBe(POLL_MS);
    expect(t.fetchCalls.map((f) => f.player)).toEqual([true, false]);
    expect(t.sent.length).toBe(1);
  });

  test("403 on currently-playing → logged once, 5 min wait", async () => {
    const t = setup(
      [
        { status: 403, data: {} },
        { status: 403, data: {} },
      ],
      { canUsePlayer: () => false },
    );
    expect(await t.poller.tick()).toBe(300000);
    expect(await t.poller.tick()).toBe(300000);
    expect(t.logs.filter((l) => l.includes("403")).length).toBe(1);
  });

  test("uses /me/player only when skipPrivateSession is on and scope granted", async () => {
    const a = setup([{ status: 204, data: "" }], { settings: { skipPrivateSession: false } });
    await a.poller.tick();
    expect(a.fetchCalls[0]?.player).toBe(false);
    const b = setup([{ status: 204, data: "" }], { canUsePlayer: () => false });
    await b.poller.tick();
    expect(b.fetchCalls[0]?.player).toBe(false);
  });
});

describe("Poller state", () => {
  test("pause clears and skips polling; resume resends", async () => {
    const t = setup([
      { status: 200, data: playing },
      { status: 200, data: playing },
    ]);
    await t.poller.tick();
    t.poller.pause();
    expect(t.sent.at(-1)).toEqual({ emoji: "", text: "" });
    expect(await t.poller.tick()).toBe(POLL_MS);
    expect(t.fetchCalls.length).toBe(1); // no poll while paused
    t.poller.resume();
    await t.poller.tick();
    expect(t.sent.at(-1)?.text).toBe("A ∙ Song (Spotify)");
  });

  test("resendSoon forces a resend of an unchanged status (Gather reconnect)", async () => {
    const t = setup([
      { status: 200, data: playing },
      { status: 200, data: playing },
    ]);
    await t.poller.tick();
    t.poller.resendSoon();
    await t.poller.tick();
    expect(t.sent.length).toBe(2);
  });

  test("outside work hours: clears, doesn't poll, waits ≤ 60s", async () => {
    const t = setup([{ status: 200, data: playing }], { settings: { workHours: "Mon-Fri 13:00-14:00" } });
    const delay = await t.poller.tick(); // Tuesday 12:00
    expect(t.fetchCalls.length).toBe(0);
    expect(t.sent).toEqual([{ emoji: "", text: "" }]);
    expect(delay).toBe(60000);
    t.advance(60 * 60000); // 13:00
    expect(await t.poller.tick()).toBe(POLL_MS);
    expect(t.fetchCalls.length).toBe(1);
  });
});

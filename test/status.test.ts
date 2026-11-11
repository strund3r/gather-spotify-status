import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Settings } from "../src/settings";
import { applyTemplate, formatStatus, isBlocked, parsePlayback, truncate } from "../src/status";

const s = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...over });

const track = (over: Record<string, unknown> = {}) => ({
  is_playing: true,
  currently_playing_type: "track",
  item: { name: "Song", album: { name: "Album" }, artists: [{ name: "Artist A" }, { name: "Artist B" }] },
  ...over,
});

describe("parsePlayback", () => {
  test("track", () => {
    const p = parsePlayback(track());
    expect(p).toMatchObject({
      kind: "track",
      isPlaying: true,
      artists: ["Artist A", "Artist B"],
      track: "Song",
      album: "Album",
    });
  });
  test("episode", () => {
    const p = parsePlayback({
      is_playing: true,
      currently_playing_type: "episode",
      item: { name: "Ep 1", show: { name: "Show" } },
    });
    expect(p).toMatchObject({ kind: "episode", episode: "Ep 1", show: "Show" });
  });
  test("nothing / garbage", () => {
    expect(parsePlayback(null).kind).toBe("none");
    expect(parsePlayback("").kind).toBe("none");
    expect(parsePlayback({ is_playing: true, currently_playing_type: "ad" }).kind).toBe("other");
  });
  test("private session flag from /me/player", () => {
    expect(parsePlayback(track({ device: { is_private_session: true } })).privateSession).toBe(true);
    expect(parsePlayback(track()).privateSession).toBe(false);
  });
});

describe("formatStatus", () => {
  test("default format", () => {
    expect(formatStatus(parsePlayback(track()), s())).toEqual({ emoji: "🎶", text: "Artist A ∙ Song (Spotify)" });
  });
  test("custom format with all placeholders", () => {
    const out = formatStatus(
      parsePlayback(track()),
      s({ statusFormat: "{artists} – {track} [{album}]", musicEmoji: "🎧" }),
    );
    expect(out).toEqual({ emoji: "🎧", text: "Artist A, Artist B – Song [Album]" });
  });
  test("podcast default and custom", () => {
    const ep = parsePlayback({
      is_playing: true,
      currently_playing_type: "episode",
      item: { name: "Ep", show: { name: "Show" } },
    });
    expect(formatStatus(ep, s()).text).toBe("Listening to a podcast on Spotify");
    expect(formatStatus(ep, s({ podcastFormat: "{show}: {episode}" }))).toEqual({ emoji: "🎙️", text: "Show: Ep" });
  });
  test("paused → clear", () => {
    expect(formatStatus(parsePlayback(track({ is_playing: false })), s())).toEqual({ emoji: "", text: "" });
  });
  test("private session → clear only when enabled", () => {
    const p = parsePlayback(track({ device: { is_private_session: true } }));
    expect(formatStatus(p, s()).text).toBe("");
    expect(formatStatus(p, s({ skipPrivateSession: false })).text).not.toBe("");
  });
  test("blocked artist → clear", () => {
    expect(formatStatus(parsePlayback(track()), s({ blockArtists: ["artist b"] })).text).toBe("");
  });
  test("truncates", () => {
    const out = formatStatus(parsePlayback(track()), s({ maxLength: 10 }));
    expect(Array.from(out.text).length).toBeLessThanOrEqual(10);
    expect(out.text).toBe("Artist A…");
    expect(out.text.endsWith("…")).toBe(true);
  });
});

describe("helpers", () => {
  test("applyTemplate: unknown placeholders empty, whitespace collapsed", () => {
    expect(applyTemplate("{a}  {nope} {b}", { a: "x", b: "y" })).toBe("x y");
  });
  test("truncate keeps emoji intact", () => {
    expect(truncate("🎶🎶🎶🎶", 3)).toBe("🎶🎶…");
    expect(truncate("short", 0)).toBe("short");
    expect(truncate("short", 10)).toBe("short");
  });
  test("isBlocked case-insensitive, any artist, tracks only", () => {
    const p = parsePlayback(track());
    expect(isBlocked(p, s({ blockArtists: [" ARTIST A "] }))).toBe(true);
    expect(isBlocked(p, s({ blockArtists: ["Other"] }))).toBe(false);
    expect(isBlocked(p, s())).toBe(false);
  });
});

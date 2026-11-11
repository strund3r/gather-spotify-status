// SPDX-License-Identifier: GPL-3.0-or-later
// Pure functions: turn a Spotify playback response into a Gather status, apply privacy rules.
import type { Settings } from "./settings";
import { isRecord } from "./util";

export interface Playback {
  /** "none" = nothing playing / no active device. */
  kind: "track" | "episode" | "other" | "none";
  isPlaying: boolean;
  artists: string[];
  track?: string;
  album?: string;
  show?: string;
  episode?: string;
  privateSession: boolean;
}

export interface GatherStatus {
  emoji: string;
  text: string;
}

export const CLEAR: GatherStatus = { emoji: "", text: "" };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nameOf = (v: unknown): string | undefined => (isRecord(v) ? str(v.name) : undefined);

/** Parse GET /me/player or GET /me/player/currently-playing JSON (204 → pass null). */
export function parsePlayback(data: unknown): Playback {
  const none: Playback = { kind: "none", isPlaying: false, artists: [], privateSession: false };
  if (!isRecord(data)) return none;
  const privateSession = isRecord(data.device) && data.device.is_private_session === true;
  const isPlaying = data.is_playing === true;
  const item = isRecord(data.item) ? data.item : undefined;
  const type = data.currently_playing_type;

  if (type === "track" && item) {
    const artists = Array.isArray(item.artists) ? item.artists.map((a) => nameOf(a) ?? "").filter(Boolean) : [];
    return { kind: "track", isPlaying, artists, track: str(item.name), album: nameOf(item.album), privateSession };
  }
  if (type === "episode") {
    return {
      kind: "episode",
      isPlaying,
      artists: [],
      episode: str(item?.name),
      show: nameOf(item?.show),
      privateSession,
    };
  }
  return { ...none, kind: type ? "other" : "none", isPlaying, privateSession };
}

/** Replace {placeholders}; unknown or empty placeholders become "". Collapses leftover separators/space. */
export function applyTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return text;
  const chars = Array.from(text); // don't split emoji / surrogate pairs
  if (chars.length <= max) return text;
  const kept = chars.slice(0, Math.max(1, max - 1)).join("");
  return `${kept.trimEnd()}…`;
}

export function isBlocked(p: Playback, s: Settings): boolean {
  if (p.kind !== "track" || s.blockArtists.length === 0) return false;
  const blocked = new Set(s.blockArtists.map((a) => a.trim().toLowerCase()));
  return p.artists.some((a) => blocked.has(a.trim().toLowerCase()));
}

/** The status to show for this playback, after privacy rules. CLEAR when nothing should be shown. */
export function formatStatus(p: Playback, s: Settings): GatherStatus {
  if (!p.isPlaying) return CLEAR;
  if (s.skipPrivateSession && p.privateSession) return CLEAR;
  if (isBlocked(p, s)) return CLEAR;

  if (p.kind === "track") {
    const text = applyTemplate(s.statusFormat, {
      artist: p.artists[0],
      artists: p.artists.join(", "),
      track: p.track,
      album: p.album,
    });
    return text ? { emoji: s.musicEmoji, text: truncate(text, s.maxLength) } : CLEAR;
  }
  if (p.kind === "episode") {
    const text = applyTemplate(s.podcastFormat, { show: p.show, episode: p.episode });
    return text ? { emoji: s.podcastEmoji, text: truncate(text, s.maxLength) } : CLEAR;
  }
  return CLEAR;
}

export function sameStatus(a: GatherStatus | undefined, b: GatherStatus): boolean {
  return !!a && a.emoji === b.emoji && a.text === b.text;
}

/** "🎶 Artist ∙ Song", or "(clear)" for an empty status. */
export function describeStatus(s: GatherStatus): string {
  return s.text ? `${s.emoji} ${s.text}` : "(clear)";
}

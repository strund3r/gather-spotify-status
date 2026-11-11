// SPDX-License-Identifier: GPL-3.0-or-later
// Work hours: "Mon-Fri 09:00-18:00", "Mon,Wed,Fri 08:30-17:00", "Daily 09:00-18:00", "off".
// End before start means overnight (e.g. "Fri 22:00-02:00": starts Friday, ends Saturday 02:00).

export interface WorkHours {
  days: Set<number>; // 0 = Sunday … 6 = Saturday (Date#getDay)
  startMin: number; // minutes since midnight
  endMin: number;
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MINUTE_MS = 60_000;
/** How far ahead msUntilWorkHours searches (a bit over a week covers every weekly schedule). */
const SEARCH_LIMIT_MIN = 8 * 24 * 60;
const FALLBACK_WAIT_MS = 60 * MINUTE_MS;

function parseDay(token: string): number {
  const i = DAY_NAMES.indexOf(token.slice(0, 3).toLowerCase());
  if (i < 0 || !/^[a-z]+$/i.test(token)) throw new Error(`unknown day "${token}"`);
  return i;
}

function parseTime(t: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) throw new Error(`invalid time "${t}" (use HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`invalid time "${t}"`);
  return h * 60 + min;
}

function parseDays(spec: string): Set<number> {
  const days = new Set<number>();
  if (/^(daily|every\s*day|all)$/i.test(spec)) {
    for (let d = 0; d < 7; d++) days.add(d);
    return days;
  }
  for (const part of spec.split(",")) {
    const [from, to, ...rest] = part.split("-");
    if (from === undefined || rest.length > 0) throw new Error(`invalid day range "${part}"`);
    if (to === undefined) {
      days.add(parseDay(from));
      continue;
    }
    let d = parseDay(from);
    const end = parseDay(to);
    for (let i = 0; i < 7; i++) {
      days.add(d);
      if (d === end) break;
      d = (d + 1) % 7;
    }
  }
  return days;
}

/** Returns null for "off". Throws Error with a readable message on invalid input. */
export function parseWorkHours(spec: string): WorkHours | null {
  const s = spec.trim();
  if (!s || /^off$/i.test(s)) return null;
  const m = /^(\S+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(s);
  if (!m?.[1] || !m[2] || !m[3]) throw new Error(`expected e.g. "Mon-Fri 09:00-18:00" or "off", got "${spec}"`);

  const days = parseDays(m[1]);
  const startMin = parseTime(m[2]);
  const endMin = parseTime(m[3]);
  if (startMin === endMin) throw new Error("start and end time are the same");
  return { days, startMin, endMin };
}

export function inWorkHours(now: Date, hours: WorkHours | null): boolean {
  if (!hours) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  if (hours.startMin < hours.endMin) {
    return hours.days.has(day) && minutes >= hours.startMin && minutes < hours.endMin;
  }
  // Overnight: the window belongs to the day it starts on.
  const yesterday = (day + 6) % 7;
  return (hours.days.has(day) && minutes >= hours.startMin) || (hours.days.has(yesterday) && minutes < hours.endMin);
}

/** Milliseconds until the next work-hours window starts (0 if inside one). */
export function msUntilWorkHours(now: Date, hours: WorkHours | null): number {
  if (!hours || inWorkHours(now, hours)) return 0;
  for (let ahead = 0; ahead <= SEARCH_LIMIT_MIN; ahead++) {
    const t = new Date(now.getTime() + ahead * MINUTE_MS);
    t.setSeconds(0, 0);
    if (inWorkHours(t, hours)) return Math.max(0, t.getTime() - now.getTime());
  }
  return FALLBACK_WAIT_MS;
}

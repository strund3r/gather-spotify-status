import { describe, expect, test } from "bun:test";
import { inWorkHours, msUntilWorkHours, parseWorkHours } from "../src/workhours";

describe("work hours", () => {
  // 2026-11-09 is a Monday.
  const at = (day: number, hh: number, mm = 0) => new Date(2026, 10, 9 + day, hh, mm);

  test("parse", () => {
    expect(parseWorkHours("off")).toBeNull();
    expect(parseWorkHours("")).toBeNull();
    const wh = parseWorkHours("Mon-Fri 09:00-18:00");
    if (!wh) throw new Error("expected work hours");
    expect([...wh.days].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(wh.startMin).toBe(540);
    expect(wh.endMin).toBe(1080);
    expect([...(parseWorkHours("Daily 08:00-09:00")?.days ?? [])].length).toBe(7);
    expect([...(parseWorkHours("mon,wed,FRI 08:00-09:00")?.days ?? [])].sort()).toEqual([1, 3, 5]);
    expect([...(parseWorkHours("Fri-Mon 08:00-09:00")?.days ?? [])].sort()).toEqual([0, 1, 5, 6]);
  });
  test("invalid input throws readable errors", () => {
    expect(() => parseWorkHours("weekdays")).toThrow();
    expect(() => parseWorkHours("Mon-Fri 9-18")).toThrow();
    expect(() => parseWorkHours("Xyz 09:00-18:00")).toThrow(/unknown day/);
    expect(() => parseWorkHours("Mon 25:00-26:00")).toThrow(/invalid time/);
    expect(() => parseWorkHours("Mon 09:00-09:00")).toThrow(/same/);
  });
  test("inside / outside", () => {
    const wh = parseWorkHours("Mon-Fri 09:00-18:00");
    expect(inWorkHours(at(0, 9, 0), wh)).toBe(true); // Mon 09:00
    expect(inWorkHours(at(0, 17, 59), wh)).toBe(true);
    expect(inWorkHours(at(0, 18, 0), wh)).toBe(false); // end exclusive
    expect(inWorkHours(at(0, 8, 59), wh)).toBe(false);
    expect(inWorkHours(at(5, 12), wh)).toBe(false); // Saturday
    expect(inWorkHours(at(5, 12), null)).toBe(true); // off = always
  });
  test("overnight window belongs to its start day", () => {
    const wh = parseWorkHours("Fri 22:00-02:00");
    expect(inWorkHours(at(4, 23), wh)).toBe(true); // Fri 23:00
    expect(inWorkHours(at(5, 1), wh)).toBe(true); // Sat 01:00
    expect(inWorkHours(at(5, 3), wh)).toBe(false);
    expect(inWorkHours(at(0, 1), wh)).toBe(false); // Mon 01:00 (Sunday not in window)
  });
  test("msUntilWorkHours", () => {
    const wh = parseWorkHours("Mon-Fri 09:00-18:00");
    expect(msUntilWorkHours(at(0, 10), wh)).toBe(0);
    expect(msUntilWorkHours(at(0, 8, 30), wh)).toBe(30 * 60000);
    expect(msUntilWorkHours(at(4, 18), wh)).toBe((2 * 24 + 15) * 3600000); // Fri 18:00 → Mon 09:00
  });
});

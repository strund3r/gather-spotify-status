import { describe, expect, test } from "bun:test";
import { DEFAULTS, describeSettings, normalizeSettings, parseSetArg, SETTING_KEYS } from "../src/settings";

describe("parseSetArg", () => {
  test("strings, keeps '=' in the value", () => {
    expect(parseSetArg("statusFormat={artist} = {track}")).toEqual({
      key: "statusFormat",
      value: "{artist} = {track}",
    });
  });
  test("numbers / booleans / lists", () => {
    expect(parseSetArg("maxLength=50").value).toBe(50);
    expect(parseSetArg("debug=yes").value).toBe(true);
    expect(parseSetArg("skipPrivateSession=off").value).toBe(false);
    expect(parseSetArg("blockArtists= A , B ,,").value).toEqual(["A", "B"]);
    expect(parseSetArg("blockArtists=").value).toEqual([]);
    expect(parseSetArg("musicEmoji=").value).toBe("");
  });
  test("work hours validated and normalized", () => {
    expect(parseSetArg("workHours=Mon-Fri 09:00-18:00").value).toBe("Mon-Fri 09:00-18:00");
    expect(parseSetArg("workHours=OFF").value).toBe("off");
    expect(() => parseSetArg("workHours=sometimes")).toThrow(/workHours/);
  });
  test("errors", () => {
    expect(() => parseSetArg("nokey")).toThrow(/key=value/);
    expect(() => parseSetArg("bogus=1")).toThrow(/unknown setting "bogus".*statusFormat/);
    expect(() => parseSetArg("maxLength=abc")).toThrow(/maxLength/);
    expect(() => parseSetArg("maxLength=-1")).toThrow();
    expect(() => parseSetArg("debug=maybe")).toThrow(/true or false/);
    expect(() => parseSetArg("statusFormat=  ")).toThrow(/empty/);
  });
});

describe("normalizeSettings", () => {
  test("defaults when missing / garbage", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULTS);
    expect(normalizeSettings("nope")).toEqual(DEFAULTS);
  });
  test("keeps valid values, drops invalid ones", () => {
    const n = normalizeSettings({ maxLength: 40, workHours: "garbage", blockArtists: ["X"], debug: "true", extra: 1 });
    expect(n.maxLength).toBe(40);
    expect(n.workHours).toBe("off");
    expect(n.blockArtists).toEqual(["X"]);
    expect(n.debug).toBe(true);
    expect("extra" in n).toBe(false);
  });
  test("defaults aren't shared/mutated", () => {
    const n = normalizeSettings({});
    n.blockArtists.push("x");
    expect(DEFAULTS.blockArtists).toEqual([]);
  });
});

test("describeSettings marks defaults", () => {
  const rows = describeSettings(normalizeSettings({ maxLength: 40 }));
  expect(rows.map((r) => r.key)).toEqual(SETTING_KEYS);
  expect(rows.find((r) => r.key === "maxLength")).toMatchObject({ value: "40", isDefault: false });
  expect(rows.find((r) => r.key === "blockArtists")).toMatchObject({ value: "(none)", isDefault: true });
});

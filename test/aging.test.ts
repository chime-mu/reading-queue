// Aging clock — counts days a session looked at the queue, never calendar days.

import { describe, expect, test } from "bun:test";
import { activeDaysSince } from "../vault";

describe("activeDaysSince", () => {
  test("a long absence ages nothing", () => {
    // captured Aug 11, no sessions until Sep 25: still 1 active day, not 45.
    expect(activeDaysSince("2026-08-11", ["2026-08-04", "2026-09-25"])).toBe(1);
  });

  test("only days on or after capture count", () => {
    expect(activeDaysSince("2026-08-10", ["2026-08-04", "2026-08-10", "2026-08-11"])).toBe(2);
  });

  test("several sessions on one day count once", () => {
    expect(activeDaysSince("2026-08-01", ["2026-08-04", "2026-08-04", "2026-08-04"])).toBe(1);
  });

  test("no capture date means no age", () => {
    expect(activeDaysSince("", ["2026-08-04"])).toBe(0);
  });
});

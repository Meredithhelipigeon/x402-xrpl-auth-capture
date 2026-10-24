import { describe, expect, it } from "vitest";
import { unixTimeToRippleTime } from "xrpl";
import { RIPPLE_EPOCH_OFFSET, fromRippleTime, toRippleTime } from "../src/time.js";

describe("ripple time", () => {
  it("maps the Ripple epoch to zero", () => {
    expect(toRippleTime(RIPPLE_EPOCH_OFFSET)).toBe(0);
    expect(fromRippleTime(0)).toBe(RIPPLE_EPOCH_OFFSET);
  });

  it("round-trips", () => {
    const unix = 1_761_330_000;
    expect(fromRippleTime(toRippleTime(unix))).toBe(unix);
  });

  it("agrees with xrpl.js, which takes milliseconds", () => {
    const unix = 1_761_330_000;
    expect(toRippleTime(unix)).toBe(unixTimeToRippleTime(unix * 1000));
  });

  it("rejects fractions and unsafe integers", () => {
    expect(() => toRippleTime(1_761_330_000.5)).toThrow(TypeError);
    expect(() => toRippleTime(Number.MAX_SAFE_INTEGER + 2)).toThrow(TypeError);
  });

  it("rejects millisecond values passed as seconds", () => {
    expect(() => toRippleTime(1_761_330_000_000)).toThrow(/milliseconds/);
  });

  it("rejects times before the Ripple epoch", () => {
    expect(() => toRippleTime(0)).toThrow(RangeError);
    expect(() => fromRippleTime(-1)).toThrow(RangeError);
  });
});

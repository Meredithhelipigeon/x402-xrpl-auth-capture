import { describe, expect, it } from "vitest";
import cc from "five-bells-condition";
import {
  PREIMAGE_LENGTH,
  conditionFromPreimage,
  fulfillmentFromPreimage,
  isWellFormedCondition,
  newPreimage,
} from "../src/condition.js";

function viaLibrary(preimage: Uint8Array): { condition: string; fulfillment: string } {
  const f = new cc.PreimageSha256();
  f.setPreimage(Buffer.from(preimage));
  return {
    condition: f.getConditionBinary().toString("hex").toUpperCase(),
    fulfillment: f.serializeBinary().toString("hex").toUpperCase(),
  };
}

describe("PREIMAGE-SHA-256 encoding", () => {
  it("matches five-bells-condition byte for byte", () => {
    for (let i = 0; i < 25; i++) {
      const preimage = newPreimage();
      const expected = viaLibrary(preimage);
      expect(conditionFromPreimage(preimage)).toBe(expected.condition);
      expect(fulfillmentFromPreimage(preimage)).toBe(expected.fulfillment);
    }
  });

  it("matches a fixed vector (all-zero preimage)", () => {
    const zero = new Uint8Array(PREIMAGE_LENGTH);
    expect(conditionFromPreimage(zero)).toBe(
      "A025802066687AADF862BD776C8FC18B8E9F8E20089714856EE233B3902A591D0D5F2925810120",
    );
    expect(fulfillmentFromPreimage(zero)).toBe("A0228020" + "00".repeat(32));
  });

  it("produces 78-character uppercase conditions", () => {
    const condition = conditionFromPreimage(newPreimage());
    expect(condition).toHaveLength(78);
    expect(condition).toBe(condition.toUpperCase());
    expect(isWellFormedCondition(condition)).toBe(true);
    expect(isWellFormedCondition(condition.toLowerCase())).toBe(true);
  });

  it("rejects malformed conditions", () => {
    const good = conditionFromPreimage(newPreimage());
    expect(isWellFormedCondition(good.slice(0, -2))).toBe(false);
    expect(isWellFormedCondition(good.replace(/810120$/, "810121"))).toBe(false);
    expect(isWellFormedCondition("A0228020" + "00".repeat(32))).toBe(false);
    expect(isWellFormedCondition("")).toBe(false);
  });

  it("never repeats a preimage", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(Buffer.from(newPreimage()).toString("hex"));
    expect(seen.size).toBe(1000);
  });

  it("rejects preimages that are not 32 bytes", () => {
    expect(() => conditionFromPreimage(new Uint8Array(31))).toThrow(TypeError);
    expect(() => fulfillmentFromPreimage(new Uint8Array(33))).toThrow(TypeError);
  });
});

import { describe, expect, it } from "vitest";
import { RippledError } from "xrpl";
import { conditionFromPreimage, fulfillmentFromPreimage, newPreimage } from "../src/condition.js";
import { buildEscrowCancel, buildEscrowFinish, getEscrowState } from "../src/lifecycle/index.js";

const preimage = newPreimage();
const condition = conditionFromPreimage(preimage);
const fulfillment = fulfillmentFromPreimage(preimage);
const ref = { owner: "rBuyerAddress", offerSequence: 42 };

describe("buildEscrowFinish", () => {
  it("builds the capture transaction", () => {
    expect(buildEscrowFinish({ ...ref, account: "rArbiter", condition, fulfillment })).toEqual({
      TransactionType: "EscrowFinish",
      Account: "rArbiter",
      Owner: "rBuyerAddress",
      OfferSequence: 42,
      Condition: condition,
      Fulfillment: fulfillment,
    });
  });

  it("accepts lowercase hex and normalizes it", () => {
    const tx = buildEscrowFinish({ ...ref, account: "rArbiter", condition: condition.toLowerCase(), fulfillment: fulfillment.toLowerCase() });
    expect(tx.Condition).toBe(condition);
    expect(tx.Fulfillment).toBe(fulfillment);
  });

  it("refuses a fulfillment for a different condition", () => {
    const wrong = fulfillmentFromPreimage(newPreimage());
    expect(() => buildEscrowFinish({ ...ref, account: "rArbiter", condition, fulfillment: wrong })).toThrow(/does not match/);
  });

  it("refuses a bad offer sequence", () => {
    expect(() => buildEscrowFinish({ ...ref, offerSequence: 0, account: "rA", condition, fulfillment })).toThrow(TypeError);
    expect(() => buildEscrowFinish({ ...ref, offerSequence: 1.5, account: "rA", condition, fulfillment })).toThrow(TypeError);
  });
});

describe("buildEscrowCancel", () => {
  it("builds the reclaim transaction", () => {
    expect(buildEscrowCancel({ ...ref, account: "rWatcher" })).toEqual({
      TransactionType: "EscrowCancel",
      Account: "rWatcher",
      Owner: "rBuyerAddress",
      OfferSequence: 42,
    });
  });
});

describe("getEscrowState", () => {
  it("is held while the ledger entry exists", async () => {
    const client = { request: async () => ({ result: {} }) } as never;
    await expect(getEscrowState(client, ref)).resolves.toBe("held");
  });

  it("is closed when the ledger reports entryNotFound", async () => {
    // Same shape xrpl.js 5.x throws: message is rippled's error_message, the code is in data.error.
    const err = new RippledError("Entry not found.", { error: "entryNotFound", error_message: "Entry not found.", status: "error" });
    const client = { request: async () => Promise.reject(err) } as never;
    await expect(getEscrowState(client, ref)).resolves.toBe("closed");
  });

  it("rethrows other errors", async () => {
    const client = { request: async () => Promise.reject(new Error("noNetwork")) } as never;
    await expect(getEscrowState(client, ref)).rejects.toThrow("noNetwork");
  });
});

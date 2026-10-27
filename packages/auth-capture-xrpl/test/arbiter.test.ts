import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import {
  HttpArbiterClient,
  canonicalJson,
  signOrder,
  signReceipt,
  verifyOrderSignature,
  verifyReceipt,
  type UnsignedReceipt,
} from "../src/arbiter.js";
import { conditionFromPreimage, newPreimage } from "../src/condition.js";

const arbiter = Wallet.generate();
const unsigned: UnsignedReceipt = {
  orderId: "ord_1",
  verdict: "PASS",
  escrow: { owner: Wallet.generate().classicAddress, offerSequence: 9 },
  finishTxHash: "ABCD",
  deliveryHash: "EF01",
  issuedAt: 1_800_000_000,
};

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined, x: 0 }], c: "s" } })).toBe('{"a":{"c":"s","d":[2,{"x":0,"z":1}]},"b":1}');
  });
});

describe("receipts", () => {
  it("round-trips sign and verify", () => {
    const r = signReceipt(arbiter, unsigned);
    expect(r.signer).toBe(arbiter.classicAddress);
    expect(r.signerPublicKey).toBe(arbiter.publicKey);
    expect(verifyReceipt(r)).toEqual({ ok: true });
    expect(verifyReceipt(r, [arbiter.classicAddress])).toEqual({ ok: true });
  });

  it("verifies regardless of key order (JSON round trip)", () => {
    const r = signReceipt(arbiter, unsigned);
    const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(r).reverse())));
    expect(verifyReceipt(shuffled)).toEqual({ ok: true });
  });

  it("rejects a flipped verdict, a swapped key, and an untrusted signer", () => {
    const r = signReceipt(arbiter, unsigned);
    expect(verifyReceipt({ ...r, verdict: "FAIL" })).toEqual({ ok: false, reason: "bad_signature" });
    const other = Wallet.generate();
    expect(verifyReceipt({ ...r, signerPublicKey: other.publicKey })).toEqual({ ok: false, reason: "signer_mismatch" });
    expect(verifyReceipt(r, [other.classicAddress])).toEqual({ ok: false, reason: "untrusted_signer" });
  });
});

describe("order signatures", () => {
  const terms = {
    network: "xrpl:1",
    orderId: "ord_1",
    condition: conditionFromPreimage(newPreimage()),
    captureDeadline: 1_800_000_150,
    payTo: Wallet.generate().classicAddress,
    amount: "1000000",
    asset: "XRP",
  };

  it("round-trips, names the signer as captureAuthorizer, and ignores condition case", () => {
    const s = signOrder(arbiter, terms);
    expect(s.captureAuthorizer).toBe(arbiter.classicAddress);
    expect(s.captureAuthorizerPublicKey).toBe(arbiter.publicKey);
    const full = { ...terms, captureAuthorizer: s.captureAuthorizer };
    expect(verifyOrderSignature(full, s.captureAuthorizerPublicKey, s.orderSignature)).toBe(true);
    expect(verifyOrderSignature({ ...full, condition: full.condition.toLowerCase() }, s.captureAuthorizerPublicKey, s.orderSignature)).toBe(true);
  });

  it.each([
    ["network", { network: "xrpl:0" }],
    ["orderId", { orderId: "ord_2" }],
    ["condition", { condition: conditionFromPreimage(newPreimage()) }],
    ["captureDeadline", { captureDeadline: 1_800_000_151 }],
    ["payTo", { payTo: Wallet.generate().classicAddress }],
    ["amount", { amount: "1000001" }],
  ])("rejects a changed %s", (_name, patch) => {
    const s = signOrder(arbiter, terms);
    expect(verifyOrderSignature({ ...terms, captureAuthorizer: s.captureAuthorizer, ...patch }, s.captureAuthorizerPublicKey, s.orderSignature)).toBe(false);
  });

  it("rejects a key that is not captureAuthorizer's, even with a valid signature from it", () => {
    const seller = Wallet.generate();
    const s = signOrder(seller, terms);
    expect(verifyOrderSignature({ ...terms, captureAuthorizer: arbiter.classicAddress }, s.captureAuthorizerPublicKey, s.orderSignature)).toBe(false);
  });

  it("rejects a receipt signature replayed as an order signature", () => {
    const r = signReceipt(arbiter, unsigned);
    expect(verifyOrderSignature({ ...terms, captureAuthorizer: arbiter.classicAddress }, r.signerPublicKey, r.signature)).toBe(false);
    expect(verifyOrderSignature({ ...terms, captureAuthorizer: arbiter.classicAddress }, "zz", "zz")).toBe(false);
  });
});

describe("HttpArbiterClient", () => {
  it("speaks the section 7.2 HTTP API", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/orders/missing")) return new Response(JSON.stringify({ error: "no order" }), { status: 404 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const c = new HttpArbiterClient("http://arb/", fetchImpl);
    await c.createOrder({ network: "xrpl:1", payTo: "rS", amount: "1", asset: "XRP", resource: "u" });
    await c.recordFunding({ orderId: "ord_1", owner: "rB", offerSequence: 3, txHash: "H" });
    await c.submitDelivery({ orderId: "ord_1", body: "{}", sellerSignature: "S", sellerPublicKey: "K", submittedBy: "buyer" });
    expect(await c.getOrder("missing")).toBeUndefined();
    expect(calls).toEqual([
      { url: "http://arb/orders", method: "POST", body: { network: "xrpl:1", payTo: "rS", amount: "1", asset: "XRP", resource: "u" } },
      { url: "http://arb/orders/ord_1/funding", method: "POST", body: { owner: "rB", offerSequence: 3, txHash: "H" } },
      { url: "http://arb/orders/ord_1/delivery", method: "POST", body: { body: "{}", sellerSignature: "S", sellerPublicKey: "K", submittedBy: "buyer" } },
      { url: "http://arb/orders/missing", method: "GET", body: undefined },
    ]);
  });
});

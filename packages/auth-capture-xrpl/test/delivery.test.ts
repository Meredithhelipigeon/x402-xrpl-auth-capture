import { describe, expect, it } from "vitest";
import { ECDSA, Wallet } from "xrpl";
import { deliveryHash, signDelivery, verifyDelivery } from "../src/delivery.js";

const body = JSON.stringify({ symbol: "XRP", price: 2.41, asOf: 1_761_330_000 });

describe.each([ECDSA.secp256k1, ECDSA.ed25519])("delivery signatures (%s)", (algorithm) => {
  const seller = Wallet.generate(algorithm);
  const other = Wallet.generate(algorithm);

  it("round-trips for the payTo account", () => {
    const signed = signDelivery(seller, "ord_1", body);
    const check = verifyDelivery({ orderId: "ord_1", body, ...signed, payTo: seller.classicAddress });
    expect(check).toEqual({ ok: true, deliveryHash: deliveryHash("ord_1", body) });
  });

  it("rejects a tampered body", () => {
    const signed = signDelivery(seller, "ord_1", body);
    const check = verifyDelivery({ orderId: "ord_1", body: body.replace("2.41", "0.01"), ...signed, payTo: seller.classicAddress });
    expect(check).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature moved to another order", () => {
    const signed = signDelivery(seller, "ord_1", body);
    const check = verifyDelivery({ orderId: "ord_2", body, ...signed, payTo: seller.classicAddress });
    expect(check).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signer that is not payTo", () => {
    const signed = signDelivery(other, "ord_1", body);
    const check = verifyDelivery({ orderId: "ord_1", body, ...signed, payTo: seller.classicAddress });
    expect(check).toEqual({ ok: false, reason: "signer_not_pay_to" });
  });

  it("rejects a correct key with someone else's signature", () => {
    const forged = signDelivery(other, "ord_1", body);
    const check = verifyDelivery({
      orderId: "ord_1",
      body,
      signature: forged.signature,
      publicKey: seller.publicKey,
      payTo: seller.classicAddress,
    });
    expect(check).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("delivery hash", () => {
  it("binds the order id and body with a newline separator", () => {
    expect(deliveryHash("ord_1", "x")).not.toBe(deliveryHash("ord_1x", ""));
    expect(deliveryHash("ord_1", "x")).toMatch(/^[0-9A-F]{64}$/);
  });

  it("refuses order ids that could shift the separator", () => {
    expect(() => deliveryHash("ord\n1", "x")).toThrow(TypeError);
    expect(() => deliveryHash("", "x")).toThrow(TypeError);
  });

  it("reports malformed input instead of throwing", () => {
    const check = verifyDelivery({ orderId: "a\nb", body, signature: "00", publicKey: "zz", payTo: "r" });
    expect(check).toEqual({ ok: false, reason: "malformed" });
  });
});

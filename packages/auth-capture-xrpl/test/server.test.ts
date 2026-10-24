import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SchemePaymentRequiredContext, SettleContext, SettleResultContext } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import type { Arbiter, ArbiterOrderView, CreateOrderInput, RecordFundingInput } from "../src/arbiter.js";
import { conditionFromPreimage, newPreimage } from "../src/condition.js";
import { AuthCaptureXrplServerScheme } from "../src/server/index.js";
import { ERRORS } from "../src/types.js";

const seller = Wallet.generate();
const buyer = Wallet.generate();
const arbiterAddress = Wallet.generate().classicAddress;

function fakeArbiter() {
  const orders = new Map<string, ArbiterOrderView>();
  const created: CreateOrderInput[] = [];
  const funded: RecordFundingInput[] = [];
  const arbiter: Arbiter = {
    createOrder: async (i) => {
      created.push(i);
      const order: ArbiterOrderView = {
        orderId: `ord_${orders.size + 1}`,
        condition: conditionFromPreimage(newPreimage()),
        captureDeadline: 1_800_000_150,
        captureAuthorizer: arbiterAddress,
        status: "created",
        payTo: i.payTo,
        amount: i.amount,
        network: i.network,
      };
      orders.set(order.orderId, order);
      return order;
    },
    getOrder: async (id) => orders.get(id),
    recordFunding: async (i) => void funded.push(i),
    submitDelivery: async () => {
      throw new Error("not used");
    },
  };
  return { arbiter, orders, created, funded };
}

function baseRequirements(): PaymentRequirements {
  return { scheme: "auth-capture", network: "xrpl:1", amount: "1000000", asset: "XRP", payTo: seller.classicAddress, maxTimeoutSeconds: 60, extra: {} };
}

async function built(scheme: AuthCaptureXrplServerScheme): Promise<PaymentRequirements> {
  return scheme.enhancePaymentRequirements(baseRequirements(), { x402Version: 2, scheme: "auth-capture", network: "xrpl:1" }, []);
}

function ctxFor(requirements: PaymentRequirements[], paymentHeader?: string): SchemePaymentRequiredContext {
  return {
    requirements,
    resourceInfo: { url: "http://localhost/quote?symbol=XRP" },
    paymentRequiredResponse: { x402Version: 2, resource: { url: "http://localhost/quote" }, accepts: requirements },
    transportContext: { request: { adapter: { getHeader: (name: string) => (name.toLowerCase() === "payment-signature" ? paymentHeader : undefined) } } },
  };
}

describe("AuthCaptureXrplServerScheme", () => {
  it("prices in XRP drops only", async () => {
    const s = new AuthCaptureXrplServerScheme({ arbiter: fakeArbiter().arbiter, captureAuthorizer: arbiterAddress });
    await expect(s.parsePrice({ asset: "XRP", amount: "1000000" }, "xrpl:1")).resolves.toEqual({ asset: "XRP", amount: "1000000" });
    await expect(s.parsePrice("250000", "xrpl:1")).resolves.toEqual({ asset: "XRP", amount: "250000" });
    await expect(s.parsePrice("$0.10", "xrpl:1")).rejects.toThrow(/Dollar/);
    await expect(s.parsePrice({ asset: "RLUSD", amount: "1" }, "xrpl:1")).rejects.toThrow(/Only XRP/);
    await expect(s.parsePrice("1.5", "xrpl:1")).rejects.toThrow(/whole number/);
  });

  it("adds the static extra fields", async () => {
    const s = new AuthCaptureXrplServerScheme({ arbiter: fakeArbiter().arbiter, captureAuthorizer: arbiterAddress });
    expect((await built(s)).extra).toEqual({
      paymentFlow: "escrow",
      areFeesSponsored: false,
      operatorType: "custom",
      captureAuthorizer: arbiterAddress,
      captureMode: "deferred",
    });
  });

  it("creates a new arbiter order for an unpaid 402, with terms", async () => {
    const { arbiter, created } = fakeArbiter();
    const s = new AuthCaptureXrplServerScheme({ arbiter, captureAuthorizer: arbiterAddress, terms: () => ({ kind: "quote", symbol: "XRP" }) });
    const [req] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)]));
    expect(req!.extra).toMatchObject({ orderId: "ord_1", captureDeadline: 1_800_000_150 });
    expect(created).toEqual([
      { network: "xrpl:1", payTo: seller.classicAddress, amount: "1000000", asset: "XRP", resource: "http://localhost/quote?symbol=XRP", terms: { kind: "quote", symbol: "XRP" } },
    ]);
  });

  it("reuses the buyer's unfunded order on the paid retry instead of creating one", async () => {
    const { arbiter, created, orders } = fakeArbiter();
    const s = new AuthCaptureXrplServerScheme({ arbiter, captureAuthorizer: arbiterAddress });
    const [first] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)]));
    const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: first!, payload: { signedTxBlob: "00" } });
    const [retry] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)], header));
    expect(retry!.extra).toEqual(first!.extra);
    expect(created).toHaveLength(1);

    orders.get("ord_1")!.status = "funded";
    const [afterFunding] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)], header));
    expect(afterFunding!.extra.orderId).toBe("ord_2");
  });

  it("does not reuse an order for different terms", async () => {
    const { arbiter, orders } = fakeArbiter();
    const s = new AuthCaptureXrplServerScheme({ arbiter, captureAuthorizer: arbiterAddress });
    const [first] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)]));
    orders.get("ord_1")!.amount = "1";
    const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: first!, payload: {} });
    const [retry] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)], header));
    expect(retry!.extra.orderId).toBe("ord_2");
  });

  it("before-handler settle aborts unless the order is unfunded and matches; after-handler is skipped", async () => {
    const { arbiter, orders } = fakeArbiter();
    const s = new AuthCaptureXrplServerScheme({ arbiter, captureAuthorizer: arbiterAddress });
    const [req] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)]));
    const payload: PaymentPayload = { x402Version: 2, accepted: req!, payload: {} };
    const ctx = (phase: SettleContext["phase"], accepted = req!): SettleContext =>
      ({ paymentPayload: { ...payload, accepted }, requirements: req!, declaredExtensions: {}, phase }) as unknown as SettleContext;

    await expect(s.schemeHooks.onBeforeSettle!(ctx("before-handler"))).resolves.toBeUndefined();
    const forged = { ...req!, extra: { ...req!.extra, condition: conditionFromPreimage(newPreimage()) } };
    await expect(s.schemeHooks.onBeforeSettle!(ctx("before-handler", forged))).resolves.toEqual({ abort: true, reason: ERRORS.order });
    orders.get("ord_1")!.status = "funded";
    await expect(s.schemeHooks.onBeforeSettle!(ctx("before-handler"))).resolves.toEqual({ abort: true, reason: ERRORS.order });
    await expect(s.schemeHooks.onBeforeSettle!(ctx("after-handler"))).resolves.toMatchObject({ skip: true, result: { success: true, transaction: "" } });
  });

  it("allows one collect per order at a time; only the claiming request can release it", async () => {
    const { arbiter } = fakeArbiter();
    const s = new AuthCaptureXrplServerScheme({ arbiter, captureAuthorizer: arbiterAddress });
    const [req] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)]));
    const ctx = (blob: string) =>
      ({ paymentPayload: { x402Version: 2, accepted: req!, payload: { signedTxBlob: blob } }, requirements: req!, declaredExtensions: {}, phase: "before-handler" }) as unknown as SettleContext;
    const failure = (blob: string) => ({ ...ctx(blob), error: new Error("x") }) as Parameters<NonNullable<typeof s.schemeHooks.onSettleFailure>>[0];

    await expect(s.schemeHooks.onBeforeSettle!(ctx("AA"))).resolves.toBeUndefined();
    // A second escrow for the same order while the first is still settling.
    await expect(s.schemeHooks.onBeforeSettle!(ctx("BB"))).resolves.toEqual({ abort: true, reason: ERRORS.order });
    // Core fires onSettleFailure for that abort; it must not free the first request's claim.
    await s.schemeHooks.onSettleFailure!(failure("BB"));
    await expect(s.schemeHooks.onBeforeSettle!(ctx("CC"))).resolves.toEqual({ abort: true, reason: ERRORS.order });
    // The first collect fails at the ledger: its claim is released and the buyer can retry.
    await s.schemeHooks.onSettleFailure!(failure("AA"));
    await expect(s.schemeHooks.onBeforeSettle!(ctx("DD"))).resolves.toBeUndefined();
  });

  it("records funding with the arbiter after the collect settles, and only then", async () => {
    const { arbiter, funded } = fakeArbiter();
    const s = new AuthCaptureXrplServerScheme({ arbiter, captureAuthorizer: arbiterAddress });
    const [req] = await s.enrichPaymentRequiredResponse(ctxFor([await built(s)]));
    const blob = buyer.sign({
      TransactionType: "EscrowCreate",
      Account: buyer.classicAddress,
      Destination: seller.classicAddress,
      Amount: "1000000",
      CancelAfter: 900_000_000,
      Condition: conditionFromPreimage(newPreimage()),
      Sequence: 77,
      Fee: "12",
    }).tx_blob;
    const ctx = (phase: SettleContext["phase"], success = true) =>
      ({
        paymentPayload: { x402Version: 2, accepted: req!, payload: { signedTxBlob: blob } },
        requirements: req!,
        declaredExtensions: {},
        phase,
        result: { success, transaction: "TXHASH", network: "xrpl:1" },
      }) as unknown as SettleResultContext;
    await s.schemeHooks.onAfterSettle!(ctx("after-handler"));
    await s.schemeHooks.onAfterSettle!(ctx("before-handler", false));
    expect(funded).toHaveLength(0);
    await s.schemeHooks.onAfterSettle!(ctx("before-handler"));
    expect(funded).toEqual([{ orderId: "ord_1", owner: buyer.classicAddress, offerSequence: 77, txHash: "TXHASH" }]);

    // The skipped after-handler settle echoes the collect, so PAYMENT-RESPONSE names the escrow tx.
    const after = await s.schemeHooks.onBeforeSettle!(ctx("after-handler"));
    expect(after).toEqual({ skip: true, result: { success: true, transaction: "TXHASH", network: "xrpl:1" } });
  });

  it("requires a facilitator that supports the custom operator", () => {
    const s = new AuthCaptureXrplServerScheme({ arbiter: fakeArbiter().arbiter, captureAuthorizer: arbiterAddress });
    const kind = (extra?: Record<string, unknown>) => ({ x402Version: 2, scheme: "auth-capture", network: "xrpl:1" as const, extra });
    expect(s.validateFacilitatorSupport("xrpl:1", kind({ operatorTypes: ["custom"] }), [])).toBeUndefined();
    expect(s.validateFacilitatorSupport("xrpl:1", kind({ operatorTypes: ["facilitator"] }), [])).toMatch(/custom/);
    expect(s.validateFacilitatorSupport("xrpl:1", kind(), [])).toMatch(/custom/);
  });
});

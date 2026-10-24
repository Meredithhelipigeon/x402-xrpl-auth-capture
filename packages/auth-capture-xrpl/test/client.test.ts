import type { PaymentRequirements } from "@x402/core/types";
import { XrplWalletSigner } from "@xrpljapan/x402-xrpl";
import { describe, expect, it } from "vitest";
import { Wallet, decode } from "xrpl";
import { AuthCaptureXrplClientScheme, type XrplClientLedger } from "../src/client/index.js";
import { conditionFromPreimage, newPreimage } from "../src/condition.js";
import { AuthCaptureXrplFacilitator, type XrplLedgerView } from "../src/facilitator/index.js";
import { toRippleTime } from "../src/time.js";

const NOW = 1_800_000_000;
const LEDGER = 2_000;
const buyer = Wallet.generate();
const seller = Wallet.generate();
const arbiter = Wallet.generate();
const condition = conditionFromPreimage(newPreimage());

function requirements(extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "auth-capture",
    network: "xrpl:1",
    amount: "1000000",
    asset: "XRP",
    payTo: seller.classicAddress,
    maxTimeoutSeconds: 60,
    extra: {
      paymentFlow: "escrow",
      areFeesSponsored: false,
      operatorType: "custom",
      captureAuthorizer: arbiter.classicAddress,
      captureMode: "deferred",
      orderId: "ord_1",
      condition: condition.toLowerCase(),
      captureDeadline: NOW + 150,
      ...extra,
    },
  };
}

const ledgerState = { sequence: 42, xrpDrops: "100000000", ownerCount: 0 };

function fakeLedger(overrides: Partial<typeof ledgerState> | null = {}): XrplClientLedger {
  return {
    getLedgerIndex: async () => LEDGER,
    getAccount: async () => (overrides === null ? null : { ...ledgerState, ...overrides }),
    getReserves: async () => ({ baseDrops: "1000000", ownerIncrementDrops: "200000" }),
    getFeeDrops: async () => "12",
    disconnect: async () => {},
  };
}

function client(opts: { trustedArbiters?: string[]; ledger?: XrplClientLedger; maxLockSeconds?: number } = {}) {
  return new AuthCaptureXrplClientScheme(new XrplWalletSigner(buyer), {
    trustedArbiters: opts.trustedArbiters ?? [arbiter.classicAddress],
    maxLockSeconds: opts.maxLockSeconds,
    connect: async () => opts.ledger ?? fakeLedger(),
    now: () => NOW,
  });
}

describe("AuthCaptureXrplClientScheme", () => {
  it("signs exactly the section 3.2 EscrowCreate", async () => {
    const res = await client().createPaymentPayload(2, requirements());
    expect(res.x402Version).toBe(2);
    expect(Object.keys(res.payload)).toEqual(["signedTxBlob"]);
    const tx = decode(String(res.payload.signedTxBlob));
    const { SigningPubKey, TxnSignature, ...fields } = tx;
    expect(SigningPubKey).toBe(buyer.publicKey);
    expect(TxnSignature).toBeTypeOf("string");
    expect(fields).toEqual({
      TransactionType: "EscrowCreate",
      Account: buyer.classicAddress,
      Destination: seller.classicAddress,
      Amount: "1000000",
      Condition: condition,
      CancelAfter: toRippleTime(NOW + 150),
      Sequence: 42,
      Fee: "12",
      Flags: 0,
      LastLedgerSequence: LEDGER + 15,
    });
  });

  it("produces a blob the facilitator's verify accepts", async () => {
    const req = requirements();
    const res = await client().createPaymentPayload(2, req);
    const view: XrplLedgerView = {
      getLedgerIndex: async () => LEDGER,
      getAccountState: async (a) =>
        a === buyer.classicAddress
          ? { xrpDrops: ledgerState.xrpDrops, ownerCount: 0, sequence: 42, flags: 0 }
          : { xrpDrops: "50000000", ownerCount: 0, sequence: 1, flags: 0 },
      getReserves: async () => ({ baseDrops: "1000000", ownerIncrementDrops: "200000" }),
      hasTicket: async () => false,
      submitBlob: async () => ({ engineResult: "tesSUCCESS", validated: true, txHash: "H" }),
      disconnect: async () => {},
    };
    const facilitator = new AuthCaptureXrplFacilitator({ connect: async () => view, now: () => NOW });
    const verdict = await facilitator.verify({ x402Version: 2, accepted: req, payload: res.payload }, req);
    expect(verdict).toEqual({ isValid: true, payer: buyer.classicAddress });
  });

  it.each([
    { name: "an untrusted arbiter", c: () => client({ trustedArbiters: [] }), req: requirements(), error: /not trusted/ },
    { name: "a lock longer than maxLockSeconds", c: () => client({ maxLockSeconds: 100 }), req: requirements(), error: /capture_deadline/ },
    { name: "a deadline too close to act on", c: () => client(), req: requirements({ captureDeadline: NOW + 5 }), error: /capture_deadline/ },
    { name: "a non-deferred capture mode", c: () => client(), req: requirements({ captureMode: "sync" }), error: /capture_mode/ },
    { name: "a non-XRP asset", c: () => client(), req: { ...requirements(), asset: "RLUSD" }, error: /Only XRP/ },
    { name: "a ticketSequence offer", c: () => client(), req: requirements({ assetTransferMethod: "ticketSequence" }), error: /assetTransferMethod/ },
    { name: "a balance below amount + fee + reserve", c: () => client({ ledger: fakeLedger({ xrpDrops: "2200011" }) }), req: requirements(), error: /Insufficient XRP/ },
    { name: "a missing payer account", c: () => client({ ledger: fakeLedger(null) }), req: requirements(), error: /does not exist/ },
  ])("refuses to sign $name", async ({ c, req, error }) => {
    await expect(c().createPaymentPayload(2, req)).rejects.toThrow(error);
  });
});

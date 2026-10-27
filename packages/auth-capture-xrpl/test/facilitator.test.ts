import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { Wallet, type EscrowCreate } from "xrpl";
import { conditionFromPreimage, newPreimage } from "../src/condition.js";
import {
  AuthCaptureXrplFacilitator,
  LSF_DEPOSIT_AUTH,
  LSF_DISABLE_MASTER,
  LSF_REQUIRE_DEST_TAG,
  type XrplAccountState,
  type XrplLedgerView,
} from "../src/facilitator/index.js";
import { toRippleTime } from "../src/time.js";
import { withOrderSignature, withoutOrderSignature } from "./order-fixture.js";
import { ERRORS } from "../src/types.js";

const NOW = 1_800_000_000;
const LEDGER = 1_000;
const buyer = Wallet.generate();
const seller = Wallet.generate();
const arbiter = Wallet.generate();
const condition = conditionFromPreimage(newPreimage());
const deadline = NOW + 150;

function requirements(extra: Record<string, unknown> = {}): PaymentRequirements {
  return withOrderSignature({
    scheme: "auth-capture",
    network: "xrpl:1",
    amount: "1000000",
    asset: "XRP",
    payTo: seller.classicAddress,
    maxTimeoutSeconds: 60,
    extra: {
      paymentFlow: "escrow",
      assetTransferMethod: "sequence",
      areFeesSponsored: false,
      operatorType: "custom",
      captureAuthorizer: arbiter.classicAddress,
      captureMode: "deferred",
      orderId: "ord_1",
      condition,
      captureDeadline: deadline,
      ...extra,
    },
  }, arbiter);
}

function escrowCreate(overrides: Record<string, unknown> = {}): EscrowCreate {
  return {
    TransactionType: "EscrowCreate",
    Account: buyer.classicAddress,
    Destination: seller.classicAddress,
    Amount: "1000000",
    Condition: condition,
    CancelAfter: toRippleTime(deadline),
    Sequence: 5,
    Fee: "12",
    Flags: 0,
    LastLedgerSequence: LEDGER + 10,
    ...overrides,
  } as EscrowCreate;
}

function payload(blob: string, req = requirements(), payloadExtra: Record<string, unknown> = {}): PaymentPayload {
  return { x402Version: 2, accepted: req, payload: { signedTxBlob: blob, ...payloadExtra } };
}

const signed = (tx: EscrowCreate, wallet = buyer) => wallet.sign(tx).tx_blob;

interface FakeLedger {
  accounts: Map<string, XrplAccountState>;
  submitted: string[];
  submitResult: string;
}

function fakeView(state: FakeLedger): XrplLedgerView {
  return {
    getLedgerIndex: async () => LEDGER,
    getAccountState: async (address) => state.accounts.get(address) ?? null,
    getReserves: async () => ({ baseDrops: "1000000", ownerIncrementDrops: "200000" }),
    hasTicket: async () => false,
    submitBlob: async (blob) => {
      state.submitted.push(blob);
      // Let other settle calls interleave, as a real network round trip would.
      await new Promise((r) => setTimeout(r, 5));
      return { engineResult: state.submitResult, validated: true, txHash: "HASH" };
    },
    disconnect: async () => {},
  };
}

function setup(accountOverrides: { buyer?: Partial<XrplAccountState>; seller?: Partial<XrplAccountState> | null } = {}) {
  const state: FakeLedger = { accounts: new Map(), submitted: [], submitResult: "tesSUCCESS" };
  state.accounts.set(buyer.classicAddress, { xrpDrops: "100000000", ownerCount: 0, sequence: 5, flags: 0, ...accountOverrides.buyer });
  if (accountOverrides.seller !== null) {
    state.accounts.set(seller.classicAddress, { xrpDrops: "50000000", ownerCount: 0, sequence: 1, flags: 0, ...accountOverrides.seller });
  }
  const facilitator = new AuthCaptureXrplFacilitator({ connect: async () => fakeView(state), now: () => NOW });
  return { facilitator, state };
}

describe("AuthCaptureXrplFacilitator.verify", () => {
  it("accepts a well-formed EscrowCreate", async () => {
    const { facilitator } = setup();
    const res = await facilitator.verify(payload(signed(escrowCreate())), requirements());
    expect(res).toEqual({ isValid: true, payer: buyer.classicAddress });
  });

  // One case per rule in AGENTS.md section 6 (1-11 here; 12 and 13 below).
  type Case = { name: string; reason: string; tx?: Record<string, unknown>; req?: Record<string, unknown>; mutate?: (p: PaymentPayload) => void; wallet?: Wallet };
  const cases: Case[] = [
    { name: "1 x402Version", reason: ERRORS.x402Version, mutate: (p) => void (p.x402Version = 1) },
    { name: "1 scheme", reason: ERRORS.scheme, mutate: (p) => void (p.accepted = { ...p.accepted, scheme: "exact" }) },
    { name: "1 network mismatch", reason: ERRORS.network, mutate: (p) => void (p.accepted = { ...p.accepted, network: "xrpl:0" }) },
    { name: "1 asset transfer method", reason: ERRORS.assetTransferMethod, req: { assetTransferMethod: "permit2" } },
    { name: "2 paymentFlow", reason: ERRORS.paymentFlow, req: { paymentFlow: "upfront" } },
    { name: "2 operatorType", reason: ERRORS.operatorType, req: { operatorType: "facilitator" } },
    { name: "2 captureMode", reason: ERRORS.captureMode, req: { captureMode: "sync" } },
    { name: "2 areFeesSponsored", reason: ERRORS.feesSponsored, req: { areFeesSponsored: true } },
    { name: "2 condition shape", reason: ERRORS.condition, req: { condition: "A0258020DEAD" } },
    { name: "2 captureAuthorizer", reason: ERRORS.captureAuthorizer, req: { captureAuthorizer: "rNotAnAddress" } },
    { name: "2 deadline too soon", reason: ERRORS.captureDeadline, req: { captureDeadline: NOW + 10 } },
    { name: "2 deadline too far", reason: ERRORS.captureDeadline, req: { captureDeadline: NOW + 7200 } },
    // Past the 30 s policy minimum, but inside maxTimeoutSeconds (60) + 20 s landing margin.
    { name: "2 deadline inside the payment window", reason: ERRORS.captureDeadline, req: { captureDeadline: NOW + 79 } },
    {
      name: "2 accepted orderId differs",
      reason: ERRORS.orderId,
      mutate: (p) => void (p.accepted = { ...p.accepted, extra: { ...p.accepted.extra, orderId: "ord_other" } }),
    },
    { name: "3 not hex", reason: ERRORS.payload, mutate: (p) => void (p.payload = { signedTxBlob: "zz" }) },
    { name: "3 transaction type", reason: ERRORS.transactionType, mutate: (p) => void (p.payload = { signedTxBlob: paymentBlob() }) },
    { name: "4 destination", reason: ERRORS.destination, tx: { Destination: arbiter.classicAddress } },
    { name: "4 destination tag", reason: ERRORS.destinationTag, tx: { DestinationTag: 7 } },
    { name: "5 amount", reason: ERRORS.amount, tx: { Amount: "999999" } },
    { name: "6 condition", reason: ERRORS.conditionMismatch, tx: { Condition: conditionFromPreimage(newPreimage()) } },
    { name: "7 CancelAfter", reason: ERRORS.cancelAfter, tx: { CancelAfter: toRippleTime(deadline) + 1 } },
    { name: "7 FinishAfter", reason: ERRORS.finishAfter, tx: { FinishAfter: toRippleTime(NOW) } },
    { name: "8 NetworkID", reason: ERRORS.networkId, tx: { NetworkID: 1 } },
    { name: "9 LastLedgerSequence missing", reason: ERRORS.lastLedgerSequence, tx: { LastLedgerSequence: undefined } },
    { name: "9 LastLedgerSequence expired", reason: ERRORS.lastLedgerSequence, tx: { LastLedgerSequence: LEDGER } },
    { name: "9 LastLedgerSequence too far", reason: ERRORS.lastLedgerSequence, tx: { LastLedgerSequence: LEDGER + 100 } },
    { name: "9 sequence", reason: ERRORS.sequence, tx: { Sequence: 4 } },
    { name: "10 fee", reason: ERRORS.fee, tx: { Fee: "5000" } },
    { name: "10 memos", reason: ERRORS.memos, tx: { Memos: [{ Memo: { MemoData: "AB" } }] } },
    { name: "10 flags", reason: ERRORS.flags, tx: { Flags: 0x80000000 } },
    { name: "11 signer is not Account", reason: ERRORS.signature, wallet: Wallet.generate() },
    { name: "11 tampered after signing", reason: ERRORS.signature, mutate: (p) => void (p.payload = { signedTxBlob: tamper(String(p.payload.signedTxBlob)) }) },
    { name: "lifecycle payload", reason: ERRORS.lifecycleNotRelayed, mutate: (p) => void (p.payload = { ...p.payload, type: "capture" }) },
  ];

  it.each(cases)("rejects $name", async ({ reason, tx, req, mutate, wallet }) => {
    const { facilitator } = setup();
    const r = requirements(req);
    const p = payload(signed(escrowCreate(tx), wallet ?? buyer), r);
    mutate?.(p);
    const res = await facilitator.verify(p, r);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe(reason);
  });

  const madeUp = conditionFromPreimage(newPreimage());
  it.each([
    // The attack: the seller names the trusted arbiter but locks the escrow with its own preimage.
    { name: "a condition the seller made up and signed itself", req: () => withOrderSignature(requirements({ condition: madeUp }), seller), tx: { Condition: madeUp } },
    { name: "a missing order signature", req: () => withoutOrderSignature(requirements()), tx: {} },
    { name: "an order signed for another amount", req: () => ({ ...requirements(), amount: "2000000" }), tx: { Amount: "2000000" } },
    {
      name: "an accepted order signature that differs",
      req: () => requirements(),
      tx: {},
      mutate: (p: PaymentPayload) => void (p.accepted = withOrderSignature(p.accepted, Wallet.generate())),
    },
  ])("2 rejects $name", async ({ req, tx, mutate }) => {
    const { facilitator } = setup();
    const r = req();
    const p = payload(signed(escrowCreate(tx)), r);
    mutate?.(p);
    const res = await facilitator.verify(p, r);
    expect(res.invalidReason).toBe(ERRORS.orderSignature);
  });

  it.each([
    { name: "12 insufficient balance (reserve for the new escrow)", reason: ERRORS.insufficientFunds, accounts: { buyer: { xrpDrops: "2200011" } } },
    { name: "12 destination missing", reason: ERRORS.destinationNotFound, accounts: { seller: null } },
    { name: "12 destination DepositAuth", reason: ERRORS.destinationFlags, accounts: { seller: { flags: LSF_DEPOSIT_AUTH } } },
    { name: "12 destination RequireDest", reason: ERRORS.destinationFlags, accounts: { seller: { flags: LSF_REQUIRE_DEST_TAG } } },
    { name: "11 master key disabled", reason: ERRORS.signature, accounts: { buyer: { flags: LSF_DISABLE_MASTER } } },
  ])("rejects $name", async ({ reason, accounts }) => {
    const { facilitator } = setup(accounts);
    const res = await facilitator.verify(payload(signed(escrowCreate())), requirements());
    expect(res.invalidReason).toBe(reason);
  });

  it("accepts a balance exactly at amount + fee + reserve", async () => {
    // base 1 XRP + one increment 0.2 XRP + amount 1 XRP + fee 12 drops
    const { facilitator } = setup({ buyer: { xrpDrops: "2200012" } });
    const res = await facilitator.verify(payload(signed(escrowCreate())), requirements());
    expect(res.isValid).toBe(true);
  });
});

describe("AuthCaptureXrplFacilitator.settle", () => {
  it("submits once and returns the x402 settle response", async () => {
    const { facilitator, state } = setup();
    const res = await facilitator.settle(payload(signed(escrowCreate())), requirements());
    expect(res).toEqual({ success: true, transaction: "HASH", network: "xrpl:1", payer: buyer.classicAddress, amount: "1000000" });
    expect(state.submitted).toHaveLength(1);
  });

  it("rule 13: concurrent settles of one blob submit once; the rest get duplicate_settlement", async () => {
    const { facilitator, state } = setup();
    const blob = signed(escrowCreate());
    const results = await Promise.all(Array.from({ length: 5 }, () => facilitator.settle(payload(blob), requirements())));
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.errorReason === ERRORS.duplicateSettlement)).toHaveLength(4);
    expect(state.submitted).toHaveLength(1);
  });

  it("keeps the dedup key after a failed submit", async () => {
    const { facilitator, state } = setup();
    state.submitResult = "tecUNFUNDED";
    const blob = signed(escrowCreate());
    const first = await facilitator.settle(payload(blob), requirements());
    expect(first).toMatchObject({ success: false, errorReason: ERRORS.insufficientFunds });
    const second = await facilitator.settle(payload(blob), requirements());
    expect(second.errorReason).toBe(ERRORS.duplicateSettlement);
  });

  it("refuses lifecycle payloads before verifying", async () => {
    const { facilitator, state } = setup();
    const res = await facilitator.settle(payload(signed(escrowCreate()), requirements(), { type: "capture" }), requirements());
    expect(res.errorReason).toBe(ERRORS.lifecycleNotRelayed);
    expect(state.submitted).toHaveLength(0);
  });

  it("does not submit when verification fails", async () => {
    const { facilitator, state } = setup();
    const res = await facilitator.settle(payload(signed(escrowCreate({ Amount: "1" }))), requirements());
    expect(res).toMatchObject({ success: false, errorReason: ERRORS.amount });
    expect(state.submitted).toHaveLength(0);
  });
});

describe("AuthCaptureXrplFacilitator supported kind", () => {
  it("advertises the binding's capabilities and no signers", () => {
    const f = new AuthCaptureXrplFacilitator();
    expect(f.getExtra("xrpl:1")).toEqual({ areFeesSponsored: false, operatorTypes: ["custom"] });
    expect(f.getSigners("xrpl:1")).toEqual([]);
  });
});

function paymentBlob(): string {
  return buyer.sign({
    TransactionType: "Payment",
    Account: buyer.classicAddress,
    Destination: seller.classicAddress,
    Amount: "1000000",
    Sequence: 5,
    Fee: "12",
    LastLedgerSequence: LEDGER + 10,
  }).tx_blob;
}

/** Change Fee from 12 to 13 drops: the blob still decodes and passes rules 1-10, but the signature no longer covers it. */
function tamper(blob: string): string {
  const fee12 = "68400000000000000C";
  const i = blob.indexOf(fee12);
  if (i < 0) throw new Error("fee field not found");
  return blob.slice(0, i) + "68400000000000000D" + blob.slice(i + fee12.length);
}

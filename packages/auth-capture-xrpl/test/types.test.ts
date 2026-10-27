import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { conditionFromPreimage, newPreimage } from "../src/condition.js";
import { ERRORS, reasonForLedgerResult, validateExtra, type AuthCaptureXrplExtra } from "../src/types.js";

const now = 1_761_330_000;
const window = { nowSeconds: now, minLockSeconds: 60, maxLockSeconds: 600 };

function goodExtra(): AuthCaptureXrplExtra {
  return {
    paymentFlow: "escrow",
    assetTransferMethod: "sequence",
    areFeesSponsored: false,
    operatorType: "custom",
    captureAuthorizer: Wallet.generate().classicAddress,
    captureMode: "deferred",
    orderId: "ord_7f3c",
    condition: conditionFromPreimage(newPreimage()),
    captureDeadline: now + 300,
    captureAuthorizerPublicKey: Wallet.generate().publicKey,
    orderSignature: "3045022100AB",
  };
}

describe("validateExtra", () => {
  it("accepts the section 3.1 shape", () => {
    expect(validateExtra(goodExtra(), window)).toMatchObject({ ok: true });
  });

  it("accepts an omitted assetTransferMethod and a lowercase condition", () => {
    const { assetTransferMethod: _omit, ...rest } = goodExtra();
    expect(validateExtra({ ...rest, condition: rest.condition.toLowerCase() }, window)).toMatchObject({ ok: true });
  });

  const cases: Array<[string, Partial<Record<keyof AuthCaptureXrplExtra, unknown>>, string]> = [
    ["paymentFlow authorization", { paymentFlow: "authorization" }, ERRORS.paymentFlow],
    ["paymentFlow missing", { paymentFlow: undefined }, ERRORS.paymentFlow],
    ["unknown transfer method", { assetTransferMethod: "eip3009" }, ERRORS.assetTransferMethod],
    ["fees sponsored", { areFeesSponsored: true }, ERRORS.feesSponsored],
    ["fees flag missing", { areFeesSponsored: undefined }, ERRORS.feesSponsored],
    ["delegated operator", { operatorType: "delegated" }, ERRORS.operatorType],
    ["sync capture", { captureMode: "sync" }, ERRORS.captureMode],
    ["capture mode missing", { captureMode: undefined }, ERRORS.captureMode],
    ["bad arbiter address", { captureAuthorizer: "rNotAnAddress" }, ERRORS.captureAuthorizer],
    ["empty order id", { orderId: "" }, ERRORS.orderId],
    ["malformed condition", { condition: "A0228020" + "00".repeat(32) }, ERRORS.condition],
    ["deadline too close", { captureDeadline: now + 30 }, ERRORS.captureDeadline],
    ["deadline too far", { captureDeadline: now + 3600 }, ERRORS.captureDeadline],
    ["deadline in milliseconds", { captureDeadline: (now + 300) * 1000 }, ERRORS.captureDeadline],
    ["deadline as a string", { captureDeadline: String(now + 300) }, ERRORS.captureDeadline],
    ["authorizer key missing", { captureAuthorizerPublicKey: undefined }, ERRORS.orderSignature],
    ["authorizer key not a key", { captureAuthorizerPublicKey: "ED00" }, ERRORS.orderSignature],
    ["order signature missing", { orderSignature: undefined }, ERRORS.orderSignature],
    ["order signature not hex", { orderSignature: "not-hex" }, ERRORS.orderSignature],
  ];

  it.each(cases)("rejects %s", (_name, patch, reason) => {
    expect(validateExtra({ ...goodExtra(), ...patch }, window)).toEqual({ ok: false, reason });
  });

  it("rejects a non-object", () => {
    expect(validateExtra(null, window)).toEqual({ ok: false, reason: ERRORS.paymentFlow });
  });
});

describe("reasonForLedgerResult", () => {
  it("maps known ledger results and falls back for the rest", () => {
    expect(reasonForLedgerResult("tecUNFUNDED")).toBe(ERRORS.insufficientFunds);
    expect(reasonForLedgerResult("tecNO_DST")).toBe(ERRORS.destinationNotFound);
    expect(reasonForLedgerResult("tefPAST_SEQ")).toBe(ERRORS.sequence);
    expect(reasonForLedgerResult("tecNO_PERMISSION")).toBe(ERRORS.captureDeadline);
    expect(reasonForLedgerResult("tecSOMETHING_NEW")).toBe(ERRORS.ledgerRejected);
  });
});

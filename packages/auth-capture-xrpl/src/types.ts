import { isValidClassicAddress } from "xrpl";
import { verifyOrderSignature } from "./arbiter.js";
import { isWellFormedCondition } from "./condition.js";

/** Wire constants for the XRPL binding of `auth-capture` (AGENTS.md section 3). */
export const SCHEME = "auth-capture" as const;
export const PAYMENT_FLOW = "escrow" as const;
export const OPERATOR_TYPE = "custom" as const;
export const CAPTURE_MODE = "deferred" as const;
export const ASSET_XRP = "XRP" as const;

export const XRPL_NETWORKS = {
  mainnet: "xrpl:0",
  testnet: "xrpl:1",
} as const;
export type XrplNetwork = (typeof XRPL_NETWORKS)[keyof typeof XRPL_NETWORKS];

export const ASSET_TRANSFER_METHODS = ["sequence", "ticketSequence"] as const;
export type AssetTransferMethod = (typeof ASSET_TRANSFER_METHODS)[number];

/** Fields that change on every 402. @x402/core drops them when matching `accepted`, so the scheme re-checks them. */
export const DYNAMIC_EXTRA_FIELDS = ["orderId", "condition", "captureDeadline", "captureAuthorizerPublicKey", "orderSignature"] as const;

/** `PaymentRequirements.extra` for this binding (AGENTS.md section 3.1). */
export interface AuthCaptureXrplExtra {
  paymentFlow: typeof PAYMENT_FLOW;
  assetTransferMethod?: AssetTransferMethod;
  areFeesSponsored: false;
  operatorType: typeof OPERATOR_TYPE;
  captureAuthorizer: string;
  captureMode: typeof CAPTURE_MODE;
  orderId: string;
  condition: string;
  /** Absolute Unix seconds. EscrowCreate.CancelAfter = captureDeadline - 946684800. */
  captureDeadline: number;
  /** Hex public key behind `captureAuthorizer`. */
  captureAuthorizerPublicKey: string;
  /** `captureAuthorizer`'s signature over the order terms (`signOrder` in arbiter.ts). */
  orderSignature: string;
}

/** `PaymentPayload.payload` for this binding (AGENTS.md section 3.2). */
export interface AuthCaptureXrplPayload {
  /** Hex of a fully signed EscrowCreate. */
  signedTxBlob: string;
}

/** Error reasons. Facilitator rules map one-to-one to AGENTS.md section 6. */
export const ERRORS = {
  // 1. envelope
  x402Version: "invalid_auth_capture_xrpl_x402_version",
  scheme: "invalid_auth_capture_xrpl_scheme",
  network: "invalid_auth_capture_xrpl_network",
  assetTransferMethod: "invalid_auth_capture_xrpl_asset_transfer_method",
  // 2. extra
  paymentFlow: "invalid_auth_capture_xrpl_payment_flow",
  operatorType: "invalid_auth_capture_xrpl_operator_type",
  captureMode: "invalid_auth_capture_xrpl_capture_mode",
  feesSponsored: "invalid_auth_capture_xrpl_fees_sponsored",
  condition: "invalid_auth_capture_xrpl_condition",
  captureAuthorizer: "invalid_auth_capture_xrpl_capture_authorizer",
  captureDeadline: "invalid_auth_capture_xrpl_capture_deadline",
  orderId: "invalid_auth_capture_xrpl_order_id",
  orderSignature: "invalid_auth_capture_xrpl_order_signature",
  asset: "invalid_auth_capture_xrpl_asset",
  // 3-7. transaction contents
  payload: "invalid_auth_capture_xrpl_payload",
  transactionType: "invalid_auth_capture_xrpl_transaction_type",
  destination: "invalid_auth_capture_xrpl_destination",
  destinationTag: "invalid_auth_capture_xrpl_destination_tag",
  amount: "invalid_auth_capture_xrpl_amount",
  conditionMismatch: "invalid_auth_capture_xrpl_condition_mismatch",
  cancelAfter: "invalid_auth_capture_xrpl_cancel_after",
  finishAfter: "invalid_auth_capture_xrpl_finish_after",
  // 8-9. network binding, sequencing
  networkId: "invalid_auth_capture_xrpl_network_id",
  lastLedgerSequence: "invalid_auth_capture_xrpl_last_ledger_sequence",
  sequence: "invalid_auth_capture_xrpl_sequence",
  ticket: "invalid_auth_capture_xrpl_ticket",
  // 10. safety
  fee: "invalid_auth_capture_xrpl_fee",
  memos: "invalid_auth_capture_xrpl_memos",
  delegate: "invalid_auth_capture_xrpl_delegate",
  signers: "invalid_auth_capture_xrpl_signers",
  flags: "invalid_auth_capture_xrpl_flags",
  // 11. signature
  signature: "invalid_auth_capture_xrpl_signature",
  // 12. accounts
  insufficientFunds: "invalid_auth_capture_xrpl_insufficient_funds",
  destinationNotFound: "invalid_auth_capture_xrpl_destination_not_found",
  destinationFlags: "invalid_auth_capture_xrpl_destination_flags",
  // 13. settle only
  duplicateSettlement: "duplicate_settlement",
  // lifecycle and server hooks
  lifecycleNotRelayed: "invalid_auth_capture_xrpl_lifecycle_not_relayed",
  order: "invalid_auth_capture_xrpl_order",
  ledgerRejected: "invalid_auth_capture_xrpl_ledger_rejected",
} as const;
export type AuthCaptureXrplError = (typeof ERRORS)[keyof typeof ERRORS];

/** Ledger results the facilitator can see at settle, mapped to x402 reasons. Anything else maps to `ledgerRejected`. */
export const LEDGER_RESULT_REASONS: Readonly<Record<string, AuthCaptureXrplError>> = {
  tecUNFUNDED: ERRORS.insufficientFunds,
  tecINSUFFICIENT_RESERVE: ERRORS.insufficientFunds,
  terINSUF_FEE_B: ERRORS.insufficientFunds,
  tecNO_DST: ERRORS.destinationNotFound,
  tecNO_DST_INSUF_XRP: ERRORS.destinationNotFound,
  tecDST_TAG_NEEDED: ERRORS.destinationFlags,
  // EscrowCreate returns it when CancelAfter has already passed (rippled EscrowCreate::doApply).
  tecNO_PERMISSION: ERRORS.captureDeadline,
  tefPAST_SEQ: ERRORS.sequence,
  terPRE_SEQ: ERRORS.sequence,
  tefNO_TICKET: ERRORS.ticket,
  tefMAX_LEDGER: ERRORS.lastLedgerSequence,
  tefBAD_AUTH: ERRORS.signature,
  temBAD_SIGNATURE: ERRORS.signature,
};

export function reasonForLedgerResult(result: string): AuthCaptureXrplError {
  return LEDGER_RESULT_REASONS[result] ?? ERRORS.ledgerRejected;
}

export function isXrplNetwork(network: string): network is XrplNetwork {
  return network === XRPL_NETWORKS.mainnet || network === XRPL_NETWORKS.testnet;
}

/** Time for a validated EscrowCreate to land: two ledger closes at a pessimistic 10 s, as in `upto` XRPL. */
export const LANDING_MARGIN_SECONDS = 20;

/**
 * Shortest lock to accept for these requirements: the policy minimum, and never less than the
 * whole window the buyer may sign for plus landing time, so the escrow can't expire before it exists.
 */
export function minLockFor(maxTimeoutSeconds: number, policyMinLockSeconds: number): number {
  return Math.max(policyMinLockSeconds, maxTimeoutSeconds + LANDING_MARGIN_SECONDS);
}

export interface LockWindow {
  /** Current Unix seconds. */
  nowSeconds: number;
  /** The capture deadline must leave the arbiter at least this long to act. */
  minLockSeconds: number;
  /** The buyer's funds may not be locked longer than this. */
  maxLockSeconds: number;
}

export type ExtraCheck = { ok: true; extra: AuthCaptureXrplExtra } | { ok: false; reason: AuthCaptureXrplError };

/**
 * Validates `extra` per AGENTS.md section 3.1 / rule 2 of section 6. Shared by the client
 * (before signing) and the facilitator (before relaying), so both refuse the same things.
 */
export function validateExtra(extra: unknown, window: LockWindow): ExtraCheck {
  if (typeof extra !== "object" || extra === null) return { ok: false, reason: ERRORS.paymentFlow };
  const e = extra as Record<string, unknown>;
  if (e.paymentFlow !== PAYMENT_FLOW) return { ok: false, reason: ERRORS.paymentFlow };
  if (e.assetTransferMethod !== undefined && !ASSET_TRANSFER_METHODS.includes(e.assetTransferMethod as AssetTransferMethod)) {
    return { ok: false, reason: ERRORS.assetTransferMethod };
  }
  if (e.areFeesSponsored !== false) return { ok: false, reason: ERRORS.feesSponsored };
  if (e.operatorType !== OPERATOR_TYPE) return { ok: false, reason: ERRORS.operatorType };
  if (e.captureMode !== CAPTURE_MODE) return { ok: false, reason: ERRORS.captureMode };
  if (typeof e.captureAuthorizer !== "string" || !isValidClassicAddress(e.captureAuthorizer)) {
    return { ok: false, reason: ERRORS.captureAuthorizer };
  }
  if (typeof e.orderId !== "string" || e.orderId.length === 0 || e.orderId.length > 128) {
    return { ok: false, reason: ERRORS.orderId };
  }
  if (typeof e.condition !== "string" || !isWellFormedCondition(e.condition)) {
    return { ok: false, reason: ERRORS.condition };
  }
  const deadline = e.captureDeadline;
  if (
    typeof deadline !== "number" ||
    !Number.isSafeInteger(deadline) ||
    deadline < window.nowSeconds + window.minLockSeconds ||
    deadline > window.nowSeconds + window.maxLockSeconds
  ) {
    return { ok: false, reason: ERRORS.captureDeadline };
  }
  if (typeof e.captureAuthorizerPublicKey !== "string" || !/^[0-9A-Fa-f]{66}$/.test(e.captureAuthorizerPublicKey)) {
    return { ok: false, reason: ERRORS.orderSignature };
  }
  if (typeof e.orderSignature !== "string" || !/^[0-9A-Fa-f]+$/.test(e.orderSignature)) {
    return { ok: false, reason: ERRORS.orderSignature };
  }
  return { ok: true, extra: e as unknown as AuthCaptureXrplExtra };
}

/**
 * True when the capture authorizer signed this order for exactly these requirements. Run by the
 * client before signing and by the facilitator before relaying: the seller writes the 402, so only
 * this signature shows the condition came from the arbiter and not from the seller.
 */
export function orderSignedByAuthorizer(
  req: { network: string; payTo: string; amount: string; asset: string },
  extra: AuthCaptureXrplExtra,
): boolean {
  return verifyOrderSignature(
    {
      network: req.network,
      orderId: extra.orderId,
      condition: extra.condition,
      captureDeadline: extra.captureDeadline,
      captureAuthorizer: extra.captureAuthorizer,
      payTo: req.payTo,
      amount: req.amount,
      asset: req.asset,
    },
    extra.captureAuthorizerPublicKey,
    extra.orderSignature,
  );
}

import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getRpcUrl, ledgerBufferFromTimeout, type XrplRpcConfig } from "@xrpljapan/x402-xrpl";
import { decode, deriveAddress, hashes, isValidClassicAddress, verifySignature } from "xrpl";
import { isWellFormedCondition } from "../condition.js";
import { toRippleTime } from "../time.js";
import {
  ASSET_TRANSFER_METHODS,
  ASSET_XRP,
  DYNAMIC_EXTRA_FIELDS,
  ERRORS,
  OPERATOR_TYPE,
  SCHEME,
  isXrplNetwork,
  minLockFor,
  orderSignedByAuthorizer,
  reasonForLedgerResult,
  validateExtra,
  type AssetTransferMethod,
  type AuthCaptureXrplError,
  type AuthCaptureXrplExtra,
} from "../types.js";
import {
  LSF_DEPOSIT_AUTH,
  LSF_DISABLE_MASTER,
  LSF_REQUIRE_DEST_TAG,
  connectLedgerView,
  type XrplLedgerView,
} from "./ledger-view.js";
import { InMemorySettlementCache, type SettlementCache } from "./settlement-cache.js";

export interface AuthCaptureXrplFacilitatorOptions {
  rpcConfig?: XrplRpcConfig;
  connect?: (url: string) => Promise<XrplLedgerView>;
  /** The deadline must leave the arbiter at least this long to act. Default 30. */
  minLockSeconds?: number;
  /** Longest the facilitator will lock a buyer's funds. Default 3600. Advertised in /supported. */
  maxLockSeconds?: number;
  /** Highest EscrowCreate Fee accepted, in drops. Default 2000. */
  maxFeeDrops?: number;
  settlementCache?: SettlementCache;
  /** Current Unix seconds. Injected in tests. */
  now?: () => number;
}

/** Fields an EscrowCreate on this binding must not carry (AGENTS.md section 3.2, rule 10). */
const FORBIDDEN_FIELDS: ReadonlyArray<[string, AuthCaptureXrplError]> = [
  ["Memos", ERRORS.memos],
  ["Delegate", ERRORS.delegate],
  ["Signers", ERRORS.signers],
];

type Decoded = Record<string, unknown>;

type Verified =
  | { ok: true; payer: string; tx: Decoded; blob: string; txHash: string; lastLedgerSequence: number; currentLedger: number }
  | { ok: false; response: VerifyResponse };

/**
 * Facilitator for `auth-capture` on XRPL. It relays only the collect: `/settle` submits the buyer's
 * presigned EscrowCreate. Capture (EscrowFinish) and reclaim (EscrowCancel) run out of band, so any
 * lifecycle payload is refused. The facilitator signs nothing and holds no funds.
 */
export class AuthCaptureXrplFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = "xrpl:*";
  readonly minLockSeconds: number;
  readonly maxLockSeconds: number;
  readonly maxFeeDrops: number;
  private readonly cache: SettlementCache;
  private readonly now: () => number;
  /** One shared connection per rippled URL; the Promise is stored so concurrent callers share an in-flight connect. */
  private readonly pool = new Map<string, Promise<XrplLedgerView>>();

  constructor(private readonly opts: AuthCaptureXrplFacilitatorOptions = {}) {
    this.minLockSeconds = opts.minLockSeconds ?? 30;
    this.maxLockSeconds = opts.maxLockSeconds ?? 3600;
    this.maxFeeDrops = opts.maxFeeDrops ?? 2000;
    this.cache = opts.settlementCache ?? new InMemorySettlementCache();
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Only what a server reads (`validateFacilitatorSupport` checks `operatorTypes`); the binding fixes everything else. */
  getExtra(_network: Network): Record<string, unknown> {
    return {
      areFeesSponsored: false,
      operatorTypes: [OPERATOR_TYPE],
    };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const result = await this.check(payload, req);
    return result.ok ? { isValid: true, payer: result.payer } : result.response;
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const failed = (errorReason: string, payer?: string, transaction = ""): SettleResponse => ({
      success: false,
      errorReason,
      transaction,
      network: req.network,
      payer,
    });

    if (isLifecyclePayload(payload)) return failed(ERRORS.lifecycleNotRelayed);
    const verified = await this.check(payload, req);
    if (!verified.ok) return failed(verified.response.invalidReason ?? "invalid_payload", verified.response.payer);

    // Rule 13: claim synchronously right after verification, before the next await.
    if (!this.cache.claim(verified.txHash, verified.lastLedgerSequence, verified.currentLedger)) {
      return failed(ERRORS.duplicateSettlement, verified.payer, verified.txHash);
    }

    const view = await this.acquireView(req.network);
    let result;
    try {
      result = await view.submitBlob(verified.blob);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...failed(ERRORS.ledgerRejected, verified.payer, verified.txHash), errorMessage: message };
    }
    if (result.engineResult !== "tesSUCCESS") {
      return {
        ...failed(reasonForLedgerResult(result.engineResult), verified.payer, result.txHash),
        errorMessage: result.engineResult,
      };
    }
    if (!result.validated) return failed(ERRORS.ledgerRejected, verified.payer, result.txHash);
    return { success: true, transaction: result.txHash, network: req.network, payer: verified.payer, amount: req.amount };
  }

  /** Disconnect pooled connections. Later calls reconnect. */
  async close(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(entries.map((p) => p.then((v) => v.disconnect()).catch(() => {})));
  }

  /** AGENTS.md section 6, rules 1-12, in order. Read-only. */
  private async check(payload: PaymentPayload, req: PaymentRequirements): Promise<Verified> {
    const fail = (reason: AuthCaptureXrplError, payer?: string): Verified => ({
      ok: false,
      response: { isValid: false, invalidReason: reason, payer },
    });

    // 1. Envelope
    if (payload.x402Version !== 2) return fail(ERRORS.x402Version);
    if (payload.accepted?.scheme !== SCHEME || req.scheme !== SCHEME) return fail(ERRORS.scheme);
    if (payload.accepted.network !== req.network || !isXrplNetwork(req.network)) return fail(ERRORS.network);
    const method = selectedTransferMethod(payload, req);
    if (method === undefined) return fail(ERRORS.assetTransferMethod);
    if (req.asset !== ASSET_XRP) return fail(ERRORS.asset);
    if (isLifecyclePayload(payload)) return fail(ERRORS.lifecycleNotRelayed);

    // 2. extra, plus the dynamic fields core does not compare for us
    const extraCheck = validateExtra(req.extra, {
      nowSeconds: this.now(),
      minLockSeconds: minLockFor(req.maxTimeoutSeconds, this.minLockSeconds),
      maxLockSeconds: this.maxLockSeconds,
    });
    if (!extraCheck.ok) return fail(extraCheck.reason);
    const extra = extraCheck.extra;
    const mismatch = dynamicFieldMismatch(payload.accepted.extra, extra);
    if (mismatch) return fail(mismatch);
    if (!orderSignedByAuthorizer(req, extra)) return fail(ERRORS.orderSignature);

    // 3. Decode
    const blob = (payload.payload as { signedTxBlob?: unknown }).signedTxBlob;
    if (typeof blob !== "string" || !/^[0-9A-Fa-f]+$/.test(blob)) return fail(ERRORS.payload);
    let tx: Decoded;
    try {
      tx = decode(blob) as Decoded;
    } catch {
      return fail(ERRORS.payload);
    }
    if (tx.TransactionType !== "EscrowCreate") return fail(ERRORS.transactionType);
    const payer = typeof tx.Account === "string" && isValidClassicAddress(tx.Account) ? tx.Account : undefined;
    if (!payer) return fail(ERRORS.payload);

    // 4. Destination
    if (tx.Destination !== req.payTo) return fail(ERRORS.destination, payer);
    if (tx.DestinationTag !== undefined) return fail(ERRORS.destinationTag, payer);

    // 5. Amount: XRP drops only
    if (typeof tx.Amount !== "string" || !/^\d+$/.test(tx.Amount) || tx.Amount !== req.amount) {
      return fail(ERRORS.amount, payer);
    }

    // 6. Condition
    if (typeof tx.Condition !== "string" || tx.Condition.toUpperCase() !== extra.condition.toUpperCase()) {
      return fail(ERRORS.conditionMismatch, payer);
    }

    // 7. CancelAfter / FinishAfter
    if (tx.CancelAfter !== toRippleTime(extra.captureDeadline)) return fail(ERRORS.cancelAfter, payer);
    if (tx.FinishAfter !== undefined) return fail(ERRORS.finishAfter, payer);

    // 8. Network binding: xrpl:0 and xrpl:1 have ids <= 1024, so NetworkID must be absent.
    if (tx.NetworkID !== undefined) return fail(ERRORS.networkId, payer);

    // 10. Safety (static parts first, so no RPC is spent on an obviously bad blob)
    if (typeof tx.Fee !== "string" || !/^\d+$/.test(tx.Fee) || BigInt(tx.Fee) > BigInt(this.maxFeeDrops)) {
      return fail(ERRORS.fee, payer);
    }
    for (const [field, reason] of FORBIDDEN_FIELDS) {
      if (tx[field] !== undefined) return fail(reason, payer);
    }
    if ((tx.Flags ?? 0) !== 0) return fail(ERRORS.flags, payer);

    // 11. Signature: single-signed by Account's master key
    if (!signedByAccount(tx, blob, payer)) return fail(ERRORS.signature, payer);

    // 9. Sequencing and expiry (needs the ledger)
    const view = await this.acquireView(req.network);
    const [currentLedger, payerState, destState] = await Promise.all([
      view.getLedgerIndex(),
      view.getAccountState(payer),
      view.getAccountState(req.payTo),
    ]);
    const lastLedger = tx.LastLedgerSequence;
    if (
      typeof lastLedger !== "number" ||
      lastLedger <= currentLedger ||
      lastLedger > currentLedger + ledgerBufferFromTimeout(req.maxTimeoutSeconds)
    ) {
      return fail(ERRORS.lastLedgerSequence, payer);
    }
    if (!payerState) return fail(ERRORS.insufficientFunds, payer);
    if ((payerState.flags & LSF_DISABLE_MASTER) !== 0) return fail(ERRORS.signature, payer);
    if (method === "sequence") {
      if (tx.TicketSequence !== undefined || tx.Sequence !== payerState.sequence) return fail(ERRORS.sequence, payer);
    } else {
      if (tx.Sequence !== 0 || typeof tx.TicketSequence !== "number") return fail(ERRORS.ticket, payer);
      if (!(await view.hasTicket(payer, tx.TicketSequence))) return fail(ERRORS.ticket, payer);
    }

    // 12. Accounts: balance covers amount + fee + the new escrow's owner reserve; destination can receive
    const reserves = await view.getReserves();
    const increment = BigInt(reserves.ownerIncrementDrops);
    const reserveAfter = BigInt(reserves.baseDrops) + increment * BigInt(payerState.ownerCount + 1);
    if (BigInt(payerState.xrpDrops) < reserveAfter + BigInt(tx.Amount) + BigInt(tx.Fee)) {
      return fail(ERRORS.insufficientFunds, payer);
    }
    if (!destState) return fail(ERRORS.destinationNotFound, payer);
    if ((destState.flags & (LSF_DEPOSIT_AUTH | LSF_REQUIRE_DEST_TAG)) !== 0) return fail(ERRORS.destinationFlags, payer);

    return {
      ok: true,
      payer,
      tx,
      blob,
      txHash: hashes.hashSignedTx(blob),
      lastLedgerSequence: lastLedger,
      currentLedger,
    };
  }

  private async acquireView(network: string): Promise<XrplLedgerView> {
    const url = getRpcUrl(network as Network, this.opts.rpcConfig);
    for (let attempt = 0; attempt < 2; attempt++) {
      let entry = this.pool.get(url);
      if (!entry) {
        entry = (this.opts.connect ?? connectLedgerView)(url);
        this.pool.set(url, entry);
      }
      let view: XrplLedgerView;
      try {
        view = await entry;
      } catch (err) {
        if (this.pool.get(url) === entry) this.pool.delete(url);
        throw err;
      }
      if (view.isAlive?.() ?? true) return view;
      if (this.pool.get(url) === entry) {
        this.pool.delete(url);
        void view.disconnect().catch(() => {});
      }
    }
    throw new Error(`xrpl connection to ${url} is unavailable`);
  }
}

/** Lifecycle ops (capture, void, ...) carry `payload.type`; this binding never relays them. */
function isLifecyclePayload(payload: PaymentPayload): boolean {
  return typeof payload.payload === "object" && payload.payload !== null && "type" in payload.payload;
}

/** `exact` XRPL section 7: accepted.extra wins, then requirements, then "sequence"; they must agree. */
function selectedTransferMethod(payload: PaymentPayload, req: PaymentRequirements): AssetTransferMethod | undefined {
  const required = req.extra?.assetTransferMethod;
  const selected = payload.accepted.extra?.assetTransferMethod ?? required ?? "sequence";
  if (!ASSET_TRANSFER_METHODS.includes(selected as AssetTransferMethod)) return undefined;
  if (required !== undefined && selected !== required) return undefined;
  return selected as AssetTransferMethod;
}

/** core drops DYNAMIC_EXTRA_FIELDS when matching `accepted`, so compare them here. */
function dynamicFieldMismatch(accepted: Record<string, unknown> | undefined, extra: AuthCaptureXrplExtra): AuthCaptureXrplError | undefined {
  const reasons: Record<(typeof DYNAMIC_EXTRA_FIELDS)[number], AuthCaptureXrplError> = {
    orderId: ERRORS.orderId,
    condition: ERRORS.conditionMismatch,
    captureDeadline: ERRORS.captureDeadline,
    captureAuthorizerPublicKey: ERRORS.orderSignature,
    orderSignature: ERRORS.orderSignature,
  };
  for (const field of DYNAMIC_EXTRA_FIELDS) {
    const a = accepted?.[field];
    const b = extra[field];
    const same = field === "condition" && typeof a === "string" ? a.toUpperCase() === String(b).toUpperCase() : a === b;
    if (!same) return reasons[field];
  }
  if (typeof accepted?.captureAuthorizer === "string" && accepted.captureAuthorizer !== extra.captureAuthorizer) {
    return ERRORS.captureAuthorizer;
  }
  return isWellFormedCondition(extra.condition) ? undefined : ERRORS.condition;
}

function signedByAccount(tx: Decoded, blob: string, account: string): boolean {
  const key = tx.SigningPubKey;
  if (typeof key !== "string" || key.length === 0) return false;
  try {
    return verifySignature(blob, key) && deriveAddress(key) === account;
  } catch {
    return false;
  }
}

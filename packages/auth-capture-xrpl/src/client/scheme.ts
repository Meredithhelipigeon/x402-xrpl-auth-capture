import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { getRpcUrl, ledgerBufferFromTimeout, type XrplRpcConfig, type XrplSigner } from "@xrpljapan/x402-xrpl";
import { Client, RippledError, type EscrowCreate } from "xrpl";
import { toRippleTime } from "../time.js";
import { ASSET_XRP, SCHEME, isXrplNetwork, validateExtra } from "../types.js";

/** The ledger reads the client needs. Injected in tests. */
export interface XrplClientLedger {
  /** Index of the latest validated ledger. */
  getLedgerIndex(): Promise<number>;
  /** Null when the account does not exist. */
  getAccount(address: string): Promise<{ sequence: number; xrpDrops: string; ownerCount: number } | null>;
  getReserves(): Promise<{ baseDrops: string; ownerIncrementDrops: string }>;
  /** Current open-ledger fee in drops. */
  getFeeDrops(): Promise<string>;
  disconnect(): Promise<void>;
}

export interface AuthCaptureXrplClientOptions {
  /** Arbiter addresses the buyer is willing to let hold its money. Required: an empty list trusts nobody. */
  trustedArbiters: string[];
  /** Longest the buyer will let its funds be locked. Default 600. */
  maxLockSeconds?: number;
  /** The deadline must leave the arbiter at least this long to act. Default 30. */
  minLockSeconds?: number;
  /** Highest fee the buyer will sign, in drops. Default 2000. */
  maxFeeDrops?: number;
  /** Refuse to sign when the balance can't cover amount + fee + the escrow's owner reserve. Default true. */
  preflight?: boolean;
  rpcConfig?: XrplRpcConfig;
  connect?: (url: string) => Promise<XrplClientLedger>;
  /** Current Unix seconds. Injected in tests. */
  now?: () => number;
}

/**
 * Buyer side of `auth-capture` on XRPL. On a 402 it checks the offer against the buyer's policy
 * (trusted arbiter, lock window), then signs an EscrowCreate that locks the price until the arbiter
 * releases it or the deadline passes. It never signs a Payment, so the seller can't be paid up front.
 */
export class AuthCaptureXrplClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  private readonly trusted: ReadonlySet<string>;
  private readonly maxLockSeconds: number;
  private readonly minLockSeconds: number;
  private readonly maxFeeDrops: number;
  private readonly preflight: boolean;
  private readonly now: () => number;

  constructor(
    private readonly signer: XrplSigner,
    private readonly opts: AuthCaptureXrplClientOptions,
  ) {
    this.trusted = new Set(opts.trustedArbiters);
    this.maxLockSeconds = opts.maxLockSeconds ?? 600;
    this.minLockSeconds = opts.minLockSeconds ?? 30;
    this.maxFeeDrops = opts.maxFeeDrops ?? 2000;
    this.preflight = opts.preflight ?? true;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    if (req.scheme !== SCHEME) throw new Error(`Unsupported scheme: ${req.scheme}`);
    if (!isXrplNetwork(req.network)) throw new Error(`Unsupported XRPL network: ${req.network}`);
    if (req.asset !== ASSET_XRP) throw new Error(`Only XRP is supported, got ${req.asset}`);
    if (!/^[1-9]\d*$/.test(req.amount)) throw new Error(`amount must be a positive whole number of drops, got ${req.amount}`);

    const check = validateExtra(req.extra, {
      nowSeconds: this.now(),
      minLockSeconds: this.minLockSeconds,
      maxLockSeconds: this.maxLockSeconds,
    });
    if (!check.ok) throw new Error(`Refusing to sign: ${check.reason}`);
    const extra = check.extra;
    if (!this.trusted.has(extra.captureAuthorizer)) {
      throw new Error(`Refusing to sign: arbiter ${extra.captureAuthorizer} is not trusted`);
    }
    if ((extra.assetTransferMethod ?? "sequence") !== "sequence") {
      throw new Error(`Unsupported assetTransferMethod: ${extra.assetTransferMethod}`);
    }

    const ledger = await (this.opts.connect ?? connectClientLedger)(getRpcUrl(req.network, this.opts.rpcConfig));
    try {
      const [currentIndex, account, feeDrops] = await Promise.all([
        ledger.getLedgerIndex(),
        ledger.getAccount(this.signer.address),
        ledger.getFeeDrops(),
      ]);
      if (!account) throw new Error(`Payer account ${this.signer.address} does not exist on ${req.network}`);
      if (BigInt(feeDrops) > BigInt(this.maxFeeDrops)) throw new Error(`Network fee ${feeDrops} drops exceeds the cap of ${this.maxFeeDrops}`);

      if (this.preflight) {
        const reserves = await ledger.getReserves();
        const reserve = BigInt(reserves.baseDrops) + BigInt(reserves.ownerIncrementDrops) * BigInt(account.ownerCount + 1);
        const needed = reserve + BigInt(req.amount) + BigInt(feeDrops);
        if (BigInt(account.xrpDrops) < needed) {
          throw new Error(`Insufficient XRP: have ${account.xrpDrops} drops, need ${needed} (amount + fee + escrow reserve)`);
        }
      }

      const tx: EscrowCreate = {
        TransactionType: "EscrowCreate",
        Account: this.signer.address,
        Destination: req.payTo,
        Amount: req.amount,
        Condition: extra.condition.toUpperCase(),
        CancelAfter: toRippleTime(extra.captureDeadline),
        Sequence: account.sequence,
        Fee: feeDrops,
        Flags: 0,
        LastLedgerSequence: currentIndex + ledgerBufferFromTimeout(req.maxTimeoutSeconds),
      };
      const { signedTxBlob } = await this.signer.sign(tx);
      return { x402Version, payload: { signedTxBlob } };
    } finally {
      await ledger.disconnect();
    }
  }
}

export async function connectClientLedger(url: string): Promise<XrplClientLedger> {
  const client = new Client(url);
  client.on("error", () => {});
  await client.connect();
  return {
    getLedgerIndex: () => client.getLedgerIndex(),
    getAccount: async (address) => {
      try {
        const info = await client.request({ command: "account_info", account: address, ledger_index: "current" });
        const d = info.result.account_data;
        return { sequence: d.Sequence, xrpDrops: d.Balance, ownerCount: d.OwnerCount };
      } catch (err) {
        if (err instanceof RippledError && (err.data as { error?: string } | undefined)?.error === "actNotFound") return null;
        throw err;
      }
    },
    getReserves: async () => {
      const r = await client.request({ command: "server_state" });
      const v = r.result.state.validated_ledger;
      if (!v) throw new Error("server_state response missing validated_ledger");
      return { baseDrops: String(v.reserve_base), ownerIncrementDrops: String(v.reserve_inc) };
    },
    getFeeDrops: async () => {
      const r = await client.request({ command: "fee" });
      const open = BigInt(r.result.drops.open_ledger_fee);
      const base = BigInt(r.result.drops.base_fee);
      // Pay the open-ledger fee when the queue is busy, but never less than 12 drops.
      return String([open, base, 12n].reduce((a, b) => (b > a ? b : a)));
    },
    disconnect: () => client.disconnect(),
  };
}

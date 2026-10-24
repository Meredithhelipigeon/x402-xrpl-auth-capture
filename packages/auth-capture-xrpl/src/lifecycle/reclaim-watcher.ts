import { EventEmitter } from "node:events";
import type { Client, Wallet } from "xrpl";
import { buildEscrowCancel, getEscrowState, type EscrowRef } from "./escrow.js";

/**
 * Returns funded escrows to their buyers once they expire (the `reclaim` operation).
 *
 * XRPL accepts EscrowCancel only once the parent ledger's close time is past CancelAfter, and close
 * time is coarse (up to ~10 s), so the watcher waits `marginSeconds` beyond CancelAfter before trying.
 * Anyone may submit EscrowCancel and the funds can only go back to the owner, so the watcher's wallet
 * only pays the fee.
 */

export interface WatchedEscrow extends EscrowRef {
  /** Ripple seconds, as in EscrowCreate.CancelAfter. */
  cancelAfter: number;
  orderId?: string;
}

export interface ReclaimWatcherEvents {
  tracked: [WatchedEscrow];
  reclaimed: [WatchedEscrow & { txHash: string }];
  /** The escrow was finished or cancelled by someone else before the watcher acted. */
  closed: [WatchedEscrow];
  /** A reclaim attempt failed; the escrow stays tracked and is retried on the next tick. */
  failed: [WatchedEscrow, Error];
}

export type ReclaimClient = Pick<Client, "request" | "submitAndWait">;

export interface ReclaimWatcherOptions {
  client: ReclaimClient;
  wallet: Wallet;
  marginSeconds?: number;
  pollIntervalMs?: number;
  /** Close time (Ripple seconds) of the latest validated ledger. Injected in tests. */
  closeTime?: () => Promise<number>;
}

export class ReclaimWatcher extends EventEmitter<ReclaimWatcherEvents> {
  readonly marginSeconds: number;
  private readonly client: ReclaimClient;
  private readonly wallet: Wallet;
  private readonly pollIntervalMs: number;
  private readonly closeTime: () => Promise<number>;
  private readonly escrows = new Map<string, WatchedEscrow>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(options: ReclaimWatcherOptions) {
    super();
    this.client = options.client;
    this.wallet = options.wallet;
    this.marginSeconds = options.marginSeconds ?? 20;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.closeTime = options.closeTime ?? (() => validatedCloseTime(this.client));
  }

  track(escrow: WatchedEscrow): void {
    this.escrows.set(key(escrow), { ...escrow });
    this.emit("tracked", escrow);
  }

  untrack(ref: EscrowRef): boolean {
    return this.escrows.delete(key(ref));
  }

  /** Escrows still being watched. */
  pending(): WatchedEscrow[] {
    return [...this.escrows.values()];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: reclaim every expired escrow. Overlapping calls are skipped, so nothing is submitted twice. */
  async tick(): Promise<void> {
    if (this.ticking || this.escrows.size === 0) return;
    this.ticking = true;
    try {
      const now = await this.closeTime();
      for (const escrow of this.pending()) {
        if (now <= escrow.cancelAfter + this.marginSeconds) continue;
        await this.reclaim(escrow);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async reclaim(escrow: WatchedEscrow): Promise<void> {
    try {
      if ((await getEscrowState(this.client, escrow)) === "closed") {
        this.untrack(escrow);
        this.emit("closed", escrow);
        return;
      }
      const tx = buildEscrowCancel({ ...escrow, account: this.wallet.classicAddress });
      const res = await this.client.submitAndWait(tx, { wallet: this.wallet, autofill: true });
      const meta = res.result.meta;
      const result = typeof meta === "object" && meta !== null && "TransactionResult" in meta ? String(meta.TransactionResult) : "unknown";
      if (result === "tesSUCCESS") {
        this.untrack(escrow);
        this.emit("reclaimed", { ...escrow, txHash: res.result.hash });
      } else {
        // tecNO_PERMISSION means the ledger does not yet see the deadline as passed; keep it and retry next tick.
        this.emit("failed", escrow, new Error(`EscrowCancel returned ${result}`));
      }
    } catch (err) {
      this.emit("failed", escrow, err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function key(ref: EscrowRef): string {
  return `${ref.owner}:${ref.offerSequence}`;
}

async function validatedCloseTime(client: Pick<Client, "request">): Promise<number> {
  const res = await client.request({ command: "ledger", ledger_index: "validated" });
  return res.result.ledger.close_time;
}

/**
 * Duplicate-settlement guard (AGENTS.md section 6 rule 13, copied from the `exact` XRPL binding).
 *
 * XRPL answers every resubmission of a known blob with the same validated success, so without this
 * a client could settle one escrow N times and get the resource N times. The key is the signed tx
 * hash, and it is kept until the tx can no longer land (its LastLedgerSequence has passed), even if
 * settlement fails, so `duplicate_settlement` means "already seen", not "already settled".
 */
export interface SettlementCache {
  /**
   * Atomically records `txHash` and returns true, or returns false if it is already recorded.
   * A multi-process facilitator needs a shared store with the same atomicity.
   */
  claim(txHash: string, lastLedgerSequence: number, currentLedger: number): boolean;
}

/** Single-process cache. `claim` is synchronous, so check-and-record cannot interleave. */
export class InMemorySettlementCache implements SettlementCache {
  private readonly entries = new Map<string, number>();

  claim(txHash: string, lastLedgerSequence: number, currentLedger: number): boolean {
    this.prune(currentLedger);
    const key = txHash.toUpperCase();
    if (this.entries.has(key)) return false;
    this.entries.set(key, lastLedgerSequence);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(currentLedger: number): void {
    for (const [key, lastLedger] of this.entries) {
      if (lastLedger < currentLedger) this.entries.delete(key);
    }
  }
}

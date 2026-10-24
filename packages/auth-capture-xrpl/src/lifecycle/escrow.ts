import type { Client, EscrowCancel, EscrowFinish } from "xrpl";
import { fulfillmentMatchesCondition, isWellFormedCondition } from "../condition.js";

/**
 * Out-of-band lifecycle for an auth-capture escrow. None of this goes through the facilitator's /settle.
 *
 * An escrow is identified by (owner, offerSequence): the payer's account and the Sequence of its
 * EscrowCreate (or the TicketSequence, if a ticket was used).
 */
export interface EscrowRef {
  owner: string;
  offerSequence: number;
}

/** capture: the arbiter releases the escrow to its fixed destination. Must validate before CancelAfter. */
export function buildEscrowFinish(input: EscrowRef & {
  account: string;
  condition: string;
  fulfillment: string;
}): EscrowFinish {
  assertOfferSequence(input.offerSequence);
  if (!isWellFormedCondition(input.condition)) throw new TypeError("condition is not a PREIMAGE-SHA-256 condition");
  if (!fulfillmentMatchesCondition(input.fulfillment, input.condition)) {
    throw new TypeError("fulfillment does not match condition");
  }
  // Fee is left to client.autofill, which scales it for the fulfillment size.
  return {
    TransactionType: "EscrowFinish",
    Account: input.account,
    Owner: input.owner,
    OfferSequence: input.offerSequence,
    Condition: input.condition.toUpperCase(),
    Fulfillment: input.fulfillment.toUpperCase(),
  };
}

/** reclaim: anyone returns the escrow to its owner. Only succeeds once ledger close time is past CancelAfter. */
export function buildEscrowCancel(input: EscrowRef & { account: string }): EscrowCancel {
  assertOfferSequence(input.offerSequence);
  return {
    TransactionType: "EscrowCancel",
    Account: input.account,
    Owner: input.owner,
    OfferSequence: input.offerSequence,
  };
}

/** "held" while the escrow object exists; "closed" once finished or cancelled (check account_tx for which). */
export type EscrowState = "held" | "closed";

export async function getEscrowState(client: Pick<Client, "request">, ref: EscrowRef): Promise<EscrowState> {
  assertOfferSequence(ref.offerSequence);
  try {
    await client.request({
      command: "ledger_entry",
      escrow: { owner: ref.owner, seq: ref.offerSequence },
      ledger_index: "validated",
    });
    return "held";
  } catch (err) {
    if (isEntryNotFound(err)) return "closed";
    throw err;
  }
}

function isEntryNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { data?: { error?: unknown } }).data;
  if (data?.error === "entryNotFound") return true;
  return err instanceof Error && /entryNotFound/.test(err.message);
}

function assertOfferSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`offerSequence must be a positive integer, got ${value}`);
  }
}

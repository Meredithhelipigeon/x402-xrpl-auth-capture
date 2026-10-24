/**
 * Finds the buyer's escrows whose CancelAfter has passed and cancels them, returning the funds.
 * Useful after an interrupted run or demo.
 *
 *   pnpm testnet:reclaim-expired
 *
 * The watcher wallet submits (and pays the fee for) each EscrowCancel; funds always go back to the owner.
 */
import type { Client } from "xrpl";
import { buildEscrowCancel } from "../packages/auth-capture-xrpl/src/index.js";
import { connect, loadWallets, txLink, validatedCloseTime } from "./lib/testnet.js";

const MARGIN_SECONDS = 20;

interface EscrowObject {
  index: string;
  Amount: string;
  CancelAfter?: number;
  PreviousTxnID: string;
}

/** OfferSequence is the creating transaction's Sequence (or TicketSequence); escrow objects don't store it. */
async function offerSequenceOf(client: Client, escrow: EscrowObject): Promise<number | undefined> {
  const res = await client.request({ command: "tx", transaction: escrow.PreviousTxnID });
  const tx = res.result.tx_json as unknown as Record<string, unknown>;
  if (tx.TransactionType !== "EscrowCreate") return undefined;
  const seq = tx.Sequence === 0 ? tx.TicketSequence : tx.Sequence;
  return typeof seq === "number" ? seq : undefined;
}

async function main(): Promise<void> {
  const w = loadWallets();
  const client = await connect();
  try {
    const owner = w.buyer.classicAddress;
    const res = await client.request({ command: "account_objects", account: owner, type: "escrow", ledger_index: "validated" });
    const escrows = res.result.account_objects as unknown as EscrowObject[];
    const now = await validatedCloseTime(client);
    console.log(`${escrows.length} open escrow(s) owned by the buyer ${owner}`);

    for (const escrow of escrows) {
      const drops = escrow.Amount;
      if (escrow.CancelAfter === undefined || now <= escrow.CancelAfter + MARGIN_SECONDS) {
        console.log(`  ${escrow.index.slice(0, 12)}…  ${drops} drops  not expired yet; skipping`);
        continue;
      }
      const offerSequence = await offerSequenceOf(client, escrow);
      if (offerSequence === undefined) {
        console.log(`  ${escrow.index.slice(0, 12)}…  could not find its EscrowCreate; skipping`);
        continue;
      }
      const tx = buildEscrowCancel({ account: w.facilitator.classicAddress, owner, offerSequence });
      const sub = await client.submitAndWait(tx, { wallet: w.facilitator, autofill: true });
      const meta = sub.result.meta;
      const result = typeof meta === "object" && meta !== null && "TransactionResult" in meta ? String(meta.TransactionResult) : "unknown";
      console.log(`  seq ${offerSequence}  ${drops} drops  ${result}  ${txLink(sub.result.hash)}`);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

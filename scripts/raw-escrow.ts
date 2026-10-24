/**
 * M1: proves the XRPL Escrow mechanics the binding relies on, with no x402 code involved.
 *
 *   pnpm testnet:raw-escrow
 *
 * Checks (AGENTS.md section 9, "Raw ledger"):
 *   1. conditional create -> finish with the right fulfillment       => tesSUCCESS, seller paid
 *   2. create -> cancel after expiry                                 => tesSUCCESS, buyer refunded
 *   3. finish with a wrong fulfillment                               => tecCRYPTOCONDITION_ERROR
 *   4. finish after expiry (right fulfillment)                       => fails (tecNO_PERMISSION)
 *   5. cancel before expiry                                          => fails (tecNO_PERMISSION)
 *
 * Roles match the demo: buyer creates, arbiter finishes, facilitator/watcher cancels.
 * Runtime is about 2 minutes (one escrow has to expire). Testnet only.
 */
import type { Client, SubmittableTransaction, Wallet } from "xrpl";
import {
  conditionFromPreimage,
  fulfillmentFromPreimage,
  newPreimage,
} from "../packages/auth-capture-xrpl/src/index.js";
import { connect, loadWallets, sleep, txLink, validatedCloseTime, xrpBalance } from "./lib/testnet.js";

const AMOUNT_DROPS = "1000000"; // 1 XRP
const LONG_LOCK_SECONDS = 600; // escrow A: must not expire while we finish it
const SHORT_LOCK_SECONDS = 45; // escrow B: expires during the run
const MARGIN_SECONDS = 20; // ledger close time is coarse (up to ~10 s); stay clear of the boundary

type Outcome = { result: string; hash: string };
type Check = { name: string; expected: string; got: string; hash?: string; pass: boolean };

const checks: Check[] = [];

function record(name: string, expected: string, outcome: Outcome, pass = outcome.result === expected): void {
  checks.push({ name, expected, got: outcome.result, hash: outcome.hash, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: expected ${expected}, got ${outcome.result}`);
  if (outcome.hash) console.log(`      ${txLink(outcome.hash)}`);
}

/** Submits, waits for validation, and returns the engine result even for tec codes. */
async function submit(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<Outcome & { sequence?: number }> {
  try {
    const res = await client.submitAndWait(tx, { wallet, autofill: true });
    const meta = res.result.meta;
    const result = typeof meta === "object" && meta !== null && "TransactionResult" in meta ? String(meta.TransactionResult) : "unknown";
    const txJson = (res.result as { tx_json?: { Sequence?: number } }).tx_json;
    return { result, hash: res.result.hash, sequence: txJson?.Sequence };
  } catch (err) {
    // Non-tec failures (tem*, tef*, tel*) are never validated; xrpl.js throws with the engine result in the message.
    const message = err instanceof Error ? err.message : String(err);
    const code = /\b(te[mfcl][A-Z_]+|tec[A-Z_]+)\b/.exec(message)?.[1] ?? `error: ${message}`;
    return { result: code, hash: "" };
  }
}

async function escrowExists(client: Client, owner: string, seq: number): Promise<boolean> {
  try {
    await client.request({ command: "ledger_entry", escrow: { owner, seq }, ledger_index: "validated" });
    return true;
  } catch (err) {
    if (err instanceof Error && /entryNotFound/.test(err.message)) return false;
    throw err;
  }
}

async function waitUntilCloseTimePast(client: Client, rippleTime: number): Promise<void> {
  for (;;) {
    const now = await validatedCloseTime(client);
    if (now > rippleTime) return;
    const left = rippleTime - now;
    process.stdout.write(`\r      waiting for ledger close time to pass the deadline: ~${left}s left   `);
    await sleep(Math.min(5_000, Math.max(1_000, left * 1000)));
  }
}

async function main(): Promise<void> {
  const w = loadWallets();
  const client = await connect();
  try {
    console.log(`buyer ${w.buyer.classicAddress}, seller ${w.seller.classicAddress}`);
    console.log(`arbiter ${w.arbiter.classicAddress}, watcher ${w.facilitator.classicAddress}\n`);
    const sellerStart = Number(await xrpBalance(client, w.seller.classicAddress));
    const buyerStart = Number(await xrpBalance(client, w.buyer.classicAddress));

    // Escrow A: long deadline, used for the finish checks.
    const preimageA = newPreimage();
    const conditionA = conditionFromPreimage(preimageA);
    const t0 = await validatedCloseTime(client);
    const createA = await submit(client, w.buyer, {
      TransactionType: "EscrowCreate",
      Account: w.buyer.classicAddress,
      Destination: w.seller.classicAddress,
      Amount: AMOUNT_DROPS,
      Condition: conditionA,
      CancelAfter: t0 + LONG_LOCK_SECONDS,
    });
    record("create escrow A (conditional, long deadline)", "tesSUCCESS", createA);
    if (createA.result !== "tesSUCCESS" || createA.sequence === undefined) throw new Error("escrow A was not created; stopping");
    const seqA = createA.sequence;

    // Escrow B: short deadline, used for the cancel and late-finish checks.
    const preimageB = newPreimage();
    const conditionB = conditionFromPreimage(preimageB);
    const t1 = await validatedCloseTime(client);
    const cancelAfterB = t1 + SHORT_LOCK_SECONDS;
    const createB = await submit(client, w.buyer, {
      TransactionType: "EscrowCreate",
      Account: w.buyer.classicAddress,
      Destination: w.seller.classicAddress,
      Amount: AMOUNT_DROPS,
      Condition: conditionB,
      CancelAfter: cancelAfterB,
    });
    record("create escrow B (conditional, short deadline)", "tesSUCCESS", createB);
    if (createB.result !== "tesSUCCESS" || createB.sequence === undefined) throw new Error("escrow B was not created; stopping");
    const seqB = createB.sequence;

    // Check 5: cancel before expiry fails.
    const earlyCancel = await submit(client, w.facilitator, {
      TransactionType: "EscrowCancel",
      Account: w.facilitator.classicAddress,
      Owner: w.buyer.classicAddress,
      OfferSequence: seqB,
    });
    record("5. cancel before expiry is refused", "tecNO_PERMISSION", earlyCancel);

    // Check 3: finish with a wrong fulfillment fails.
    const wrongFinish = await submit(client, w.arbiter, {
      TransactionType: "EscrowFinish",
      Account: w.arbiter.classicAddress,
      Owner: w.buyer.classicAddress,
      OfferSequence: seqA,
      Condition: conditionA,
      Fulfillment: fulfillmentFromPreimage(newPreimage()),
    });
    record("3. finish with a wrong fulfillment is refused", "tecCRYPTOCONDITION_ERROR", wrongFinish);

    // Check 1: finish with the right fulfillment pays the seller.
    const finishA = await submit(client, w.arbiter, {
      TransactionType: "EscrowFinish",
      Account: w.arbiter.classicAddress,
      Owner: w.buyer.classicAddress,
      OfferSequence: seqA,
      Condition: conditionA,
      Fulfillment: fulfillmentFromPreimage(preimageA),
    });
    const sellerAfter = Number(await xrpBalance(client, w.seller.classicAddress));
    const sellerGain = Math.round((sellerAfter - sellerStart) * 1e6);
    const aClosed = !(await escrowExists(client, w.buyer.classicAddress, seqA));
    record(
      `1. finish with the right fulfillment (seller +${sellerGain} drops, escrow closed: ${aClosed})`,
      "tesSUCCESS",
      finishA,
      finishA.result === "tesSUCCESS" && sellerGain === Number(AMOUNT_DROPS) && aClosed,
    );

    // Wait for escrow B to expire, with margin.
    console.log(`\n      escrow B expires at ripple time ${cancelAfterB}; waiting ${MARGIN_SECONDS}s past it`);
    await waitUntilCloseTimePast(client, cancelAfterB + MARGIN_SECONDS);
    console.log("\n");

    // Check 4: finish after expiry fails, even with the right fulfillment.
    const lateFinish = await submit(client, w.arbiter, {
      TransactionType: "EscrowFinish",
      Account: w.arbiter.classicAddress,
      Owner: w.buyer.classicAddress,
      OfferSequence: seqB,
      Condition: conditionB,
      Fulfillment: fulfillmentFromPreimage(preimageB),
    });
    record("4. finish after expiry is refused", "tecNO_PERMISSION", lateFinish);

    // Check 2: cancel after expiry refunds the buyer.
    const buyerBeforeCancel = Number(await xrpBalance(client, w.buyer.classicAddress));
    const cancelB = await submit(client, w.facilitator, {
      TransactionType: "EscrowCancel",
      Account: w.facilitator.classicAddress,
      Owner: w.buyer.classicAddress,
      OfferSequence: seqB,
    });
    const buyerAfterCancel = Number(await xrpBalance(client, w.buyer.classicAddress));
    const refund = Math.round((buyerAfterCancel - buyerBeforeCancel) * 1e6);
    const bClosed = !(await escrowExists(client, w.buyer.classicAddress, seqB));
    record(
      `2. cancel after expiry (buyer +${refund} drops, escrow closed: ${bClosed})`,
      "tesSUCCESS",
      cancelB,
      cancelB.result === "tesSUCCESS" && refund === Number(AMOUNT_DROPS) && bClosed,
    );

    const buyerEnd = Number(await xrpBalance(client, w.buyer.classicAddress));
    console.log(`\nbuyer: ${buyerStart} -> ${buyerEnd} XRP (paid 1 XRP to the seller, plus two creation fees)`);
  } finally {
    await client.disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * M6: honest and cheat scenarios end to end on testnet (AGENTS.md section 9).
 *
 *   pnpm facilitator & pnpm arbiter & pnpm seller   # three terminals
 *   pnpm testnet:e2e [honest|cheat|all] [--runs N]
 *
 * honest: the buyer pays by escrow, the quote is judged PASS, EscrowFinish validates,
 *         and the seller's balance rises by exactly the price.
 * cheat:  the quote is judged FAIL, nobody finishes, the facilitator's watcher cancels after
 *         the deadline, and the buyer ends at its start balance minus the EscrowCreate fee.
 */
import { buyQuote, txLink } from "@demo/common";
import { getEscrowState } from "../packages/auth-capture-xrpl/src/index.js";
import { connect, loadWallets, sleep } from "./lib/testnet.js";
import type { Client } from "xrpl";

type Scenario = "honest" | "cheat";
const PRICE = 1_000_000n;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  const extra = detail === undefined ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra}`);
}

async function drops(client: Client, address: string): Promise<bigint> {
  const info = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
  return BigInt(info.result.account_data.Balance);
}

async function txFee(client: Client, hash: string): Promise<bigint> {
  const tx = await client.request({ command: "tx", transaction: hash });
  return BigInt(String((tx.result as { tx_json?: { Fee?: string }; Fee?: string }).tx_json?.Fee ?? (tx.result as { Fee?: string }).Fee));
}

async function waitForValidatedBalance(client: Client, address: string, predicate: (d: bigint) => boolean, timeoutMs: number): Promise<bigint> {
  const until = Date.now() + timeoutMs;
  let d = await drops(client, address);
  while (!predicate(d) && Date.now() < until) {
    await sleep(3_000);
    d = await drops(client, address);
  }
  return d;
}

async function run(client: Client, scenario: Scenario, w: ReturnType<typeof loadWallets>): Promise<void> {
  console.log(`\n=== ${scenario} ===`);
  const buyerStart = await drops(client, w.buyer.classicAddress);
  const sellerStart = await drops(client, w.seller.classicAddress);

  const result = await buyQuote({ symbol: "XRP", mode: scenario });
  check("paid the 402 and got the quote", result.status === 200, { status: result.status, body: result.body.slice(0, 120) });
  check("escrow locked", Boolean(result.escrowTx), result.escrowTx && txLink(result.escrowTx));
  check("receipt is signed by the trusted arbiter", result.receiptValid, result.receipt?.signer);
  const receipt = result.receipt;
  if (!receipt || !result.escrowTx) return;
  const createFee = await txFee(client, result.escrowTx);
  const escrow = receipt.escrow;

  if (scenario === "honest") {
    check("verdict PASS", receipt.verdict === "PASS", receipt.reason);
    check("EscrowFinish validated", Boolean(receipt.finishTxHash), receipt.finishTxHash && txLink(receipt.finishTxHash));
    const sellerEnd = await waitForValidatedBalance(client, w.seller.classicAddress, (d) => d >= sellerStart + PRICE, 30_000);
    check("seller balance rose by exactly the price", sellerEnd - sellerStart === PRICE, `${sellerEnd - sellerStart} drops`);
    const buyerEnd = await drops(client, w.buyer.classicAddress);
    check("buyer paid price + EscrowCreate fee", buyerStart - buyerEnd === PRICE + createFee, `${buyerStart - buyerEnd} drops`);
    if (escrow) check("escrow closed", (await getEscrowState(client, escrow)) === "closed");
    return;
  }

  check("verdict FAIL", receipt.verdict === "FAIL", receipt.reason);
  check("no EscrowFinish", receipt.finishTxHash === undefined);
  if (!escrow) return check("receipt names the escrow", false);
  check("escrow still held after FAIL", (await getEscrowState(client, escrow)) === "held");
  console.log("      waiting for the deadline and the facilitator's watcher (about 3 minutes)...");
  const until = Date.now() + 300_000;
  let state = await getEscrowState(client, escrow);
  while (state === "held" && Date.now() < until) {
    await sleep(5_000);
    state = await getEscrowState(client, escrow);
  }
  check("watcher reclaimed the escrow", state === "closed");
  const buyerEnd = await waitForValidatedBalance(client, w.buyer.classicAddress, (d) => d >= buyerStart - createFee, 30_000);
  check("buyer is back to start minus the EscrowCreate fee", buyerStart - buyerEnd === createFee, `${buyerStart - buyerEnd} drops (fee ${createFee})`);
  const sellerEnd = await drops(client, w.seller.classicAddress);
  check("seller received nothing", sellerEnd === sellerStart, `${sellerEnd - sellerStart} drops`);
}

async function main(): Promise<void> {
  const arg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
  const runsFlag = process.argv.indexOf("--runs");
  const runs = runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 1;
  const scenarios: Scenario[] = arg === "all" ? ["honest", "cheat"] : [arg as Scenario];
  if (!scenarios.every((s) => s === "honest" || s === "cheat")) {
    console.error("usage: pnpm testnet:e2e [honest|cheat|all] [--runs N]");
    process.exit(2);
  }
  const w = loadWallets();
  const client = await connect();
  try {
    for (let i = 1; i <= runs; i++) {
      if (runs > 1) console.log(`\n##### run ${i} of ${runs}`);
      for (const s of scenarios) await run(client, s, w);
    }
  } finally {
    await client.disconnect();
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

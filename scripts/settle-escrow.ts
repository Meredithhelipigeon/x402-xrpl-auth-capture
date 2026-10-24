/**
 * M3 testnet proof: a real EscrowCreate settles through the running facilitator app.
 *
 *   pnpm facilitator          # in another terminal
 *   pnpm testnet:settle-escrow
 *
 * Builds and signs the section 3.2 EscrowCreate by hand (the client scheme is M4), then:
 *   1. POST /verify                     => isValid
 *   2. three concurrent POST /settle    => one success, two duplicate_settlement; escrow held
 *   3. POST /settle again afterwards    => refused (sequence already consumed)
 *   4. wait past the deadline           => the facilitator's watcher reclaims it to the buyer
 */
import { ledgerBufferFromTimeout } from "@xrpljapan/x402-xrpl";
import type { EscrowCreate } from "xrpl";
import { conditionFromPreimage, getEscrowState, newPreimage, toRippleTime } from "../packages/auth-capture-xrpl/src/index.js";
import { connect, loadWallets, sleep, txLink } from "./lib/testnet.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4020";
const LOCK_SECONDS = 60;
const AMOUNT = "1000000";

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const w = loadWallets();
  const client = await connect();
  let failures = 0;
  const check = (label: string, ok: boolean, detail: unknown) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  };
  try {
    const deadline = Math.floor(Date.now() / 1000) + LOCK_SECONDS;
    const requirements = {
      scheme: "auth-capture",
      network: "xrpl:1",
      amount: AMOUNT,
      asset: "XRP",
      payTo: w.seller.classicAddress,
      maxTimeoutSeconds: 60,
      extra: {
        paymentFlow: "escrow",
        assetTransferMethod: "sequence",
        areFeesSponsored: false,
        operatorType: "custom",
        captureAuthorizer: w.arbiter.classicAddress,
        captureMode: "deferred",
        orderId: `ord_m3_${Date.now()}`,
        condition: conditionFromPreimage(newPreimage()),
        captureDeadline: deadline,
      },
    };
    const tx: EscrowCreate = await client.autofill({
      TransactionType: "EscrowCreate",
      Account: w.buyer.classicAddress,
      Destination: w.seller.classicAddress,
      Amount: AMOUNT,
      Condition: requirements.extra.condition,
      CancelAfter: toRippleTime(deadline),
      Flags: 0,
    });
    tx.LastLedgerSequence = (await client.getLedgerIndex()) + ledgerBufferFromTimeout(requirements.maxTimeoutSeconds);
    const { tx_blob } = w.buyer.sign(tx);
    const paymentPayload = { x402Version: 2, accepted: requirements, payload: { signedTxBlob: tx_blob } };

    const verified = await post("/verify", { paymentPayload, paymentRequirements: requirements });
    check("1. /verify accepts the EscrowCreate", verified.isValid === true, verified);

    const body = { paymentPayload, paymentRequirements: requirements };
    const results = await Promise.all([post("/settle", body), post("/settle", body), post("/settle", body)]);
    const settled = results.find((r) => r.success === true) ?? results[0]!;
    const dupes = results.filter((r) => r.errorReason === "duplicate_settlement").length;
    check("2. one of three concurrent /settle calls submits it", settled.success === true && dupes === 2, results.map((r) => r.success || r.errorReason));
    if (settled.success) console.log(`      ${txLink(String(settled.transaction))}`);
    const state = await getEscrowState(client, { owner: w.buyer.classicAddress, offerSequence: tx.Sequence! });
    check("2. escrow is held on ledger", state === "held", state);

    const again = await post("/settle", body);
    check("3. a later /settle of the same blob is refused", again.success === false, again.errorReason);

    console.log(`      waiting for the deadline (${LOCK_SECONDS}s) plus the watcher's margin...`);
    const until = Date.now() + (LOCK_SECONDS + 90) * 1000;
    let closed = false;
    while (Date.now() < until && !closed) {
      await sleep(5_000);
      closed = (await getEscrowState(client, { owner: w.buyer.classicAddress, offerSequence: tx.Sequence! })) === "closed";
    }
    check("4. the facilitator's watcher reclaimed the escrow", closed, closed ? "closed" : "still held");
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

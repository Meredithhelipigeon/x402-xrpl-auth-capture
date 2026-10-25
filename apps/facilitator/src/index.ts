import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { Client, decode, type TxResponse } from "xrpl";
import {
  AuthCaptureXrplFacilitator,
  ReclaimWatcher,
  buildEscrowFinish,
  fulfillmentMatchesCondition,
  type AuthCaptureXrplPayload,
} from "x402-auth-capture-xrpl";
import { NETWORK, PORTS, emit, txLink, wallet, wsUrl } from "@demo/common";

/**
 * Demo facilitator: /supported, /verify, /settle for auth-capture on XRPL testnet, /capture for an
 * arbiter that holds the release secret but no XRPL key (Misa), plus the ReclaimWatcher that
 * returns expired escrows to buyers. Modelled on
 * @xrpljapan/x402-xrpl's examples/multichain/src/facilitator.ts.
 */

const scheme = new AuthCaptureXrplFacilitator({
  rpcConfig: { rpcUrl: wsUrl() },
  maxLockSeconds: Number(process.env.FACILITATOR_MAX_LOCK_SECONDS ?? 3600),
});
const facilitator = new x402Facilitator().register([NETWORK], scheme);

const watcherClient = new Client(wsUrl());
watcherClient.on("error", () => {});
const watcher = new ReclaimWatcher({ client: watcherClient, wallet: wallet("facilitator") });
watcher.on("tracked", (e) => console.log(`watching escrow ${e.owner}:${e.offerSequence} (order ${e.orderId ?? "?"})`));
watcher.on("reclaimed", (e) => {
  console.log(`reclaimed ${e.owner}:${e.offerSequence} ${txLink(e.txHash)}`);
  emit({ type: "escrow_reclaimed", source: "facilitator", orderId: e.orderId, txHash: e.txHash, detail: { owner: e.owner, offerSequence: e.offerSequence } });
});
watcher.on("closed", (e) => console.log(`escrow ${e.owner}:${e.offerSequence} already closed; no reclaim needed`));
watcher.on("failed", (e, err) => console.log(`reclaim of ${e.owner}:${e.offerSequence} failed (${err.message}); retrying`));

/** After a successful collect, start watching the escrow so it refunds if nobody captures it. */
function trackSettled(paymentPayload: { payload?: unknown; accepted?: { extra?: Record<string, unknown> } }): void {
  const blob = (paymentPayload.payload as Partial<AuthCaptureXrplPayload> | undefined)?.signedTxBlob;
  if (typeof blob !== "string") return;
  const tx = decode(blob) as { Account: string; Sequence: number; TicketSequence?: number; CancelAfter: number };
  const offerSequence = tx.Sequence === 0 && tx.TicketSequence ? tx.TicketSequence : tx.Sequence;
  const orderId = paymentPayload.accepted?.extra?.orderId;
  watcher.track({ owner: tx.Account, offerSequence, cancelAfter: tx.CancelAfter, orderId: typeof orderId === "string" ? orderId : undefined });
}

const app = express();
app.use(express.json());

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.get("/watching", (_req, res) => {
  res.json(watcher.pending());
});

app.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  try {
    res.json(await facilitator.verify(paymentPayload, paymentRequirements));
  } catch (err) {
    res.json({ isValid: false, invalidReason: "unexpected_verify_error", errorMessage: errorMessage(err) });
  }
});

app.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  try {
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    if (result.success) {
      console.log(`escrow locked ${txLink(result.transaction)}`);
      trackSettled(paymentPayload);
      emit({
        type: "escrow_locked",
        source: "facilitator",
        orderId: paymentPayload?.accepted?.extra?.orderId,
        txHash: result.transaction,
        detail: { payer: result.payer, amount: result.amount },
      });
    } else {
      console.log(`settle refused: ${result.errorReason}${result.errorMessage ? ` (${result.errorMessage})` : ""}`);
    }
    res.json(result);
  } catch (err) {
    res.json({ success: false, errorReason: "unexpected_settle_error", errorMessage: errorMessage(err), transaction: "", network: NETWORK });
  }
});

/**
 * Capture for an arbiter: given the EscrowCreate this facilitator settled and the fulfillment, submit
 * the EscrowFinish from the facilitator's account. Anyone holding the fulfillment can finish an
 * escrow on XRPL, and the money can only go to the escrow's own Destination, so relaying it is safe.
 * Answers in SettleResponse's shape: 200 when the finish validated, 4xx when no money moved, 5xx when
 * it may have (the caller must then check the ledger).
 */
app.post("/capture", async (req, res) => {
  const { network, transaction, fulfillment } = (req.body ?? {}) as Record<string, unknown>;
  const refuse = (status: number, errorReason: string, errorMessage?: string, tx = "") =>
    void res.status(status).json({ success: false, errorReason, errorMessage, transaction: tx, network: NETWORK });
  if (network !== NETWORK) return refuse(400, "invalid_auth_capture_xrpl_network");
  if (typeof transaction !== "string" || !/^[0-9A-Fa-f]{64}$/.test(transaction)) return refuse(400, "invalid_auth_capture_xrpl_payload", "transaction must be an EscrowCreate hash");
  if (typeof fulfillment !== "string") return refuse(400, "invalid_auth_capture_xrpl_payload", "fulfillment is required");
  await withCaptureLock(async () => {
    // The caller usually captures seconds after settle: give this server time to see it validated.
    let created: TxResponse["result"] | undefined;
    for (let attempt = 0; attempt < CAPTURE_LOOKUP_ATTEMPTS; attempt++) {
      created = await watcherClient
        .request({ command: "tx", transaction })
        .then((r) => r.result)
        .catch(() => undefined);
      if (created?.validated) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!created) return refuse(404, "invalid_auth_capture_xrpl_payload", "no such transaction on this ledger");
    const tx = (created as unknown as { tx_json?: Record<string, unknown> }).tx_json ?? (created as unknown as Record<string, unknown>);
    const meta = created.meta;
    const result = typeof meta === "object" && meta !== null ? meta.TransactionResult : undefined;
    if (!created.validated || tx.TransactionType !== "EscrowCreate" || result !== "tesSUCCESS") {
      return refuse(422, "invalid_auth_capture_xrpl_transaction_type", "not a validated, successful EscrowCreate");
    }
    const owner = String(tx.Account);
    const offerSequence = tx.Sequence === 0 && typeof tx.TicketSequence === "number" ? tx.TicketSequence : Number(tx.Sequence);
    const condition = String(tx.Condition ?? "");
    if (!fulfillmentMatchesCondition(fulfillment, condition)) return refuse(422, "invalid_auth_capture_xrpl_condition_mismatch", "fulfillment does not match the escrow's condition");
    const finish = buildEscrowFinish({ account: wallet("facilitator").classicAddress, owner, offerSequence, condition, fulfillment });
    try {
      const sub = await watcherClient.submitAndWait(finish, { wallet: wallet("facilitator"), autofill: true });
      const finishMeta = sub.result.meta;
      const code = typeof finishMeta === "object" && finishMeta !== null ? String(finishMeta.TransactionResult) : "unknown";
      if (code !== "tesSUCCESS") return refuse(422, "invalid_auth_capture_xrpl_ledger_rejected", code, sub.result.hash);
      console.log(`captured ${owner}:${offerSequence} ${txLink(sub.result.hash)}`);
      emit({ type: "escrow_finished", source: "facilitator", txHash: sub.result.hash, detail: { owner, offerSequence } });
      res.json({ success: true, transaction: sub.result.hash, network: NETWORK, payer: owner });
    } catch (err) {
      // Submitted or not, we don't know whether it landed.
      refuse(502, "unexpected_capture_error", errorMessage(err));
    }
  });
});

const CAPTURE_LOOKUP_ATTEMPTS = 15;

/** One capture at a time, so two finishes from the facilitator's account don't race for a Sequence. */
let captureQueue: Promise<unknown> = Promise.resolve();
function withCaptureLock(fn: () => Promise<void>): Promise<void> {
  const next = captureQueue.then(fn, fn);
  captureQueue = next.catch(() => {});
  return next;
}

// Malformed bodies still get the 200 + protocol-shaped JSON that HTTPFacilitatorClient expects.
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (req.path === "/settle" || req.path === "/capture") {
    res.json({ success: false, errorReason: "malformed_request", errorMessage: err.message, transaction: "", network: NETWORK });
  } else {
    res.json({ isValid: false, invalidReason: "malformed_request", errorMessage: err.message });
  }
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

await watcherClient.connect();
watcher.start();
app.listen(PORTS.facilitator, () => {
  console.log(`facilitator on http://localhost:${PORTS.facilitator} (watcher ${wallet("facilitator").classicAddress})`);
  console.log(`supported: ${JSON.stringify(facilitator.getSupported().kinds)}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    watcher.stop();
    void Promise.allSettled([scheme.close(), watcherClient.disconnect()]).finally(() => process.exit(0));
  });
}

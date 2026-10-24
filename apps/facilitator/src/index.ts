import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { Client, decode } from "xrpl";
import { AuthCaptureXrplFacilitator, ReclaimWatcher, type AuthCaptureXrplPayload } from "x402-auth-capture-xrpl";
import { NETWORK, PORTS, emit, txLink, wallet, wsUrl } from "@demo/common";

/**
 * Demo facilitator: /supported, /verify, /settle for auth-capture on XRPL testnet, plus the
 * ReclaimWatcher that returns expired escrows to buyers. Modelled on
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

// Malformed bodies still get the 200 + protocol-shaped JSON that HTTPFacilitatorClient expects.
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (req.path === "/settle") {
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

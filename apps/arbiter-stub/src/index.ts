import { randomBytes } from "node:crypto";
import express from "express";
import { Client, type LedgerEntryResponse } from "xrpl";
import {
  buildEscrowFinish,
  conditionFromPreimage,
  fulfillmentFromPreimage,
  getEscrowState,
  isXrplNetwork,
  newPreimage,
  signReceipt,
  toRippleTime,
  verifyDelivery,
  type ArbiterOrderStatus,
  type ArbiterOrderView,
  type ArbiterReceipt,
  type CreateOrderInput,
} from "x402-auth-capture-xrpl";
import { PORTS, URLS, emit, txLink, wallet, wsUrl } from "@demo/common";
import { judgeFromEnv } from "./judge.js";

/**
 * Demo arbiter: implements the Arbiter HTTP API (AGENTS.md section 7.2). It holds the money side
 * (preimage, funding check, EscrowFinish); Misa's checks against the seller's listing decide the verdict (judge.ts).
 * Orders live in memory. Each holds a fresh 32-byte preimage that never leaves this process.
 */

const LOCK_SECONDS = Number(process.env.ARBITER_LOCK_SECONDS ?? 150);
/** Don't start an EscrowFinish this close to the deadline: ledger close time is coarse (AGENTS.md section 11). */
const FINISH_MARGIN_SECONDS = 20;

const arbiterWallet = wallet("arbiter");
const judging = judgeFromEnv(process.env.SELLER_OPENAPI_URL ?? `${URLS.seller}/openapi.json`);
const client = new Client(wsUrl());
client.on("error", () => {});

interface Order extends ArbiterOrderView {
  status: ArbiterOrderStatus;
  terms?: unknown;
  preimage: Uint8Array;
  delivery?: { deliveryHash: string; receipt: ArbiterReceipt };
}

const orders = new Map<string, Order>();
/** One delivery at a time per order, so two submissions can't both finish or both judge. */
const locks = new Map<string, Promise<unknown>>();

function serialize(order: Order): ArbiterOrderView {
  const { preimage: _p, delivery: _d, terms: _t, ...view } = order;
  return view;
}

function withLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(orderId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(orderId, next.catch(() => {}));
  return next;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function getOrderOr404(id: string): Order {
  const order = orders.get(id);
  if (!order) throw new HttpError(404, `no order ${id}`);
  return order;
}

async function closeTime(): Promise<number> {
  const res = await client.request({ command: "ledger", ledger_index: "validated" });
  return res.result.ledger.close_time;
}

/** The escrow must exist on ledger and lock exactly this order's terms. */
async function checkEscrow(order: Order, owner: string, offerSequence: number): Promise<string | undefined> {
  let node: Record<string, unknown>;
  try {
    const res = (await client.request({
      command: "ledger_entry",
      escrow: { owner, seq: offerSequence },
      ledger_index: "validated",
    })) as LedgerEntryResponse;
    node = res.result.node as unknown as Record<string, unknown>;
  } catch {
    return "escrow not found on ledger";
  }
  if (node.Destination !== order.payTo) return "escrow destination is not the order's payTo";
  if (node.Amount !== order.amount) return "escrow amount does not match the order";
  if (String(node.Condition).toUpperCase() !== order.condition) return "escrow condition does not match the order";
  if (node.CancelAfter !== toRippleTime(order.captureDeadline)) return "escrow CancelAfter does not match the order";
  return undefined;
}

function receipt(order: Order, fields: Omit<ArbiterReceipt, "orderId" | "issuedAt" | "signer" | "signerPublicKey" | "signature">): ArbiterReceipt {
  return signReceipt(arbiterWallet, {
    orderId: order.orderId,
    escrow: order.escrow ? { owner: order.escrow.owner, offerSequence: order.escrow.offerSequence } : undefined,
    issuedAt: Math.floor(Date.now() / 1000),
    ...fields,
  });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/orders", (req, res) => {
  const input = req.body as Partial<CreateOrderInput>;
  if (typeof input.network !== "string" || !isXrplNetwork(input.network)) throw new HttpError(400, "network must be xrpl:0 or xrpl:1");
  if (input.asset !== "XRP") throw new HttpError(400, "only XRP orders are supported");
  if (typeof input.payTo !== "string" || typeof input.amount !== "string" || !/^[1-9]\d*$/.test(input.amount)) {
    throw new HttpError(400, "payTo and amount (drops) are required");
  }
  const preimage = newPreimage();
  const order: Order = {
    orderId: `ord_${randomBytes(8).toString("hex")}`,
    condition: conditionFromPreimage(preimage),
    captureDeadline: Math.floor(Date.now() / 1000) + LOCK_SECONDS,
    captureAuthorizer: arbiterWallet.classicAddress,
    status: "created",
    network: input.network,
    payTo: input.payTo,
    amount: input.amount,
    asset: input.asset,
    resource: input.resource,
    terms: input.terms,
    preimage,
  };
  orders.set(order.orderId, order);
  console.log(`order ${order.orderId}: ${order.amount} drops to ${order.payTo}, deadline in ${LOCK_SECONDS}s`);
  emit({ type: "payment_required", source: "arbiter", orderId: order.orderId, detail: { amount: order.amount, payTo: order.payTo, resource: order.resource, captureDeadline: order.captureDeadline } });
  res.status(201).json({
    orderId: order.orderId,
    condition: order.condition,
    captureDeadline: order.captureDeadline,
    captureAuthorizer: order.captureAuthorizer,
  });
});

app.get("/orders/:id", async (req, res) => {
  const order = getOrderOr404(req.params.id);
  // Notice reclaims lazily: an escrow that closed without our finish went back to the buyer.
  if (order.escrow && ["funded", "failed", "passed"].includes(order.status)) {
    const state = await getEscrowState(client, order.escrow).catch(() => "held");
    if (state === "closed") order.status = "reclaimed";
  }
  res.json(serialize(order));
});

app.post("/orders/:id/funding", async (req, res) => {
  const order = getOrderOr404(req.params.id);
  const { owner, offerSequence, txHash } = req.body as { owner?: unknown; offerSequence?: unknown; txHash?: unknown };
  if (typeof owner !== "string" || typeof offerSequence !== "number" || typeof txHash !== "string") {
    throw new HttpError(400, "owner, offerSequence and txHash are required");
  }
  if (order.escrow) {
    if (order.escrow.owner === owner && order.escrow.offerSequence === offerSequence) return void res.json(serialize(order));
    throw new HttpError(409, "order is already funded by a different escrow");
  }
  const problem = await checkEscrow(order, owner, offerSequence);
  if (problem) throw new HttpError(422, problem);
  order.escrow = { owner, offerSequence, txHash };
  order.status = "funded";
  console.log(`order ${order.orderId}: funded by ${owner}:${offerSequence}`);
  res.json(serialize(order));
});

app.post("/orders/:id/delivery", async (req, res) => {
  const order = getOrderOr404(req.params.id);
  const { body, sellerSignature, sellerPublicKey, submittedBy } = req.body as Record<string, unknown>;
  if (typeof body !== "string" || typeof sellerSignature !== "string" || typeof sellerPublicKey !== "string") {
    throw new HttpError(400, "body, sellerSignature and sellerPublicKey are required");
  }
  const result = await withLock(order.orderId, async () => {
    const check = verifyDelivery({ orderId: order.orderId, body, signature: sellerSignature, publicKey: sellerPublicKey, payTo: order.payTo! });
    if (!check.ok) throw new HttpError(422, `delivery signature rejected: ${check.reason}`);

    if (order.delivery) {
      // The same delivery again: hand back the same receipt.
      if (order.delivery.deliveryHash === check.deliveryHash) return order.delivery.receipt;
      // A second, different body the seller also signed: the seller equivocated.
      order.status = "failed";
      const r = receipt(order, { verdict: "FAIL", reason: "seller signed two different deliveries for this order", deliveryHash: check.deliveryHash });
      order.delivery = { deliveryHash: check.deliveryHash, receipt: r };
      emit({ type: "verdict", source: "arbiter", orderId: order.orderId, detail: { verdict: "FAIL", reason: r.reason } });
      return r;
    }
    if (!order.escrow) throw new HttpError(409, "order is not funded yet");

    emit({ type: "delivered", source: "arbiter", orderId: order.orderId, detail: { submittedBy, bytes: body.length, deliveryHash: check.deliveryHash } });
    const judgement = await judging.judge(body, order.terms);
    console.log(`order ${order.orderId}: ${judgement.verdict}${"reason" in judgement ? ` (${judgement.reason})` : ""}`);
    emit({ type: "verdict", source: "arbiter", orderId: order.orderId, detail: { ...judgement } });

    if (judgement.verdict === "FAIL") {
      order.status = "failed";
      const r = receipt(order, { verdict: "FAIL", reason: judgement.reason, deliveryHash: check.deliveryHash });
      order.delivery = { deliveryHash: check.deliveryHash, receipt: r };
      return r;
    }

    order.status = "passed";
    let finishTxHash: string | undefined;
    let reason: string | undefined;
    if ((await closeTime()) >= toRippleTime(order.captureDeadline) - FINISH_MARGIN_SECONDS) {
      reason = "passed too close to the deadline to finish; the escrow will refund";
    } else {
      const tx = buildEscrowFinish({
        account: arbiterWallet.classicAddress,
        owner: order.escrow.owner,
        offerSequence: order.escrow.offerSequence,
        condition: order.condition,
        fulfillment: fulfillmentFromPreimage(order.preimage),
      });
      const sub = await client.submitAndWait(tx, { wallet: arbiterWallet, autofill: true });
      const meta = sub.result.meta;
      const code = typeof meta === "object" && meta !== null ? String(meta.TransactionResult) : "unknown";
      if (code === "tesSUCCESS") {
        finishTxHash = sub.result.hash;
        order.status = "finished";
        console.log(`order ${order.orderId}: finished ${txLink(finishTxHash)}`);
        emit({ type: "escrow_finished", source: "arbiter", orderId: order.orderId, txHash: finishTxHash });
      } else {
        reason = `EscrowFinish returned ${code}`;
      }
    }
    const r = receipt(order, { verdict: "PASS", reason, finishTxHash, deliveryHash: check.deliveryHash });
    order.delivery = { deliveryHash: check.deliveryHash, receipt: r };
    return r;
  });
  res.json(result);
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

await client.connect();
app.listen(PORTS.arbiter, () => {
  console.log(`arbiter stub on http://localhost:${PORTS.arbiter} as ${arbiterWallet.classicAddress} (lock ${LOCK_SECONDS}s, judged by ${judging.name === "misa" ? `Misa at ${judging.url}` : `the local stand-in reading ${judging.url}; set MISA_CHECKS_URL to use Misa`})`);
});

import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  AuthCaptureXrplClientScheme,
  DELIVERY_PUBLIC_KEY_HEADER,
  DELIVERY_SIGNATURE_HEADER,
  HttpArbiterClient,
  XrplWalletSigner,
  verifyReceipt,
  type ArbiterReceipt,
} from "x402-auth-capture-xrpl";
import { NETWORK, URLS, address, wallet, wsUrl } from "./env.js";
import { emit } from "./events.js";

/**
 * The buyer's whole flow, shared by scripts/e2e.ts and the buyer agent:
 * pay the 402 with an escrow, receive the signed quote, hand it to the arbiter, check the receipt.
 */

export interface BuyOptions {
  symbol: string;
  mode?: "honest" | "cheat";
  /** Hard cap per payment, in drops. The client refuses anything above it. */
  maxDropsPerPayment?: string;
  maxLockSeconds?: number;
}

export interface BuyResult {
  orderId: string;
  status: number;
  body: string;
  escrowTx?: string;
  receipt?: ArbiterReceipt;
  receiptValid: boolean;
}

export async function buyQuote(opts: BuyOptions): Promise<BuyResult> {
  const arbiterAddress = address("arbiter");
  const scheme = new AuthCaptureXrplClientScheme(new XrplWalletSigner(wallet("buyer")), {
    trustedArbiters: [arbiterAddress],
    maxLockSeconds: opts.maxLockSeconds ?? 600,
    rpcConfig: { rpcUrl: wsUrl() },
  });
  let orderId: string | undefined;
  const client = new x402Client()
    .register(NETWORK, scheme)
    .setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: NETWORK, asset: "XRP", maxAmountPerPayment: opts.maxDropsPerPayment ?? "2000000" }],
    })
    .onAfterPaymentCreation(async (ctx) => {
      const id = ctx.paymentPayload.accepted.extra.orderId;
      orderId = typeof id === "string" ? id : undefined;
    });
  const paidFetch = wrapFetchWithPayment(fetch, client);

  const url = new URL("/quote", URLS.seller);
  url.searchParams.set("symbol", opts.symbol);
  if (opts.mode === "cheat") url.searchParams.set("mode", "cheat");
  const res = await paidFetch(url);
  const body = await res.text();
  if (!orderId) throw new Error(`no payment was made (HTTP ${res.status}): ${body.slice(0, 300)}`);
  if (!res.ok) return { orderId, status: res.status, body, receiptValid: false };

  const header = res.headers.get("payment-response");
  const escrowTx = header ? decodePaymentResponseHeader(header).transaction : undefined;
  const sellerSignature = res.headers.get(DELIVERY_SIGNATURE_HEADER);
  const sellerPublicKey = res.headers.get(DELIVERY_PUBLIC_KEY_HEADER);
  if (!sellerSignature || !sellerPublicKey) throw new Error("seller response is not signed");

  emit({ type: "delivered", source: "buyer", orderId, detail: { forwardedToArbiter: true } });
  const receipt = await new HttpArbiterClient(URLS.arbiter).submitDelivery({
    orderId,
    body,
    sellerSignature,
    sellerPublicKey,
    submittedBy: "buyer",
  });
  const receiptValid = verifyReceipt(receipt, [arbiterAddress]).ok && receipt.orderId === orderId;
  return { orderId, status: res.status, body, escrowTx, receipt, receiptValid };
}

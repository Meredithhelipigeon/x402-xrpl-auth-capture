import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  AuthCaptureXrplServerScheme,
  DELIVERY_PUBLIC_KEY_HEADER,
  DELIVERY_SIGNATURE_HEADER,
  HttpArbiterClient,
  signDelivery,
} from "x402-auth-capture-xrpl";
import { NETWORK, PORTS, URLS, address, emit, wallet } from "@demo/common";

/**
 * Demo seller: one paid route, GET /quote?symbol=XRP at 1 XRP. Payment is an escrow the arbiter
 * releases only if the quote is good. `?mode=cheat` (or SELLER_MODE=cheat) returns a bad quote,
 * still signed, so the arbiter can prove the seller sent it.
 */

const PRICE_DROPS = process.env.SELLER_PRICE_DROPS ?? "1000000";
const sellerWallet = wallet("seller");
const arbiter = new HttpArbiterClient(URLS.arbiter);

const scheme = new AuthCaptureXrplServerScheme({
  arbiter,
  captureAuthorizer: address("arbiter"),
  terms: (_req, resourceUrl) => ({ kind: "quote", symbol: symbolFrom(resourceUrl), maxAgeSeconds: 60 }),
});

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: URLS.facilitator })).register(NETWORK, scheme);

function symbolFrom(url: string): string {
  try {
    return (new URL(url, "http://localhost").searchParams.get("symbol") ?? "XRP").toUpperCase();
  } catch {
    return "XRP";
  }
}

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /quote": {
        accepts: {
          scheme: "auth-capture",
          network: NETWORK,
          payTo: sellerWallet.classicAddress,
          price: { asset: "XRP", amount: PRICE_DROPS },
          maxTimeoutSeconds: 60,
        },
        description: "Latest price quote, paid by escrow and released by an independent arbiter",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/quote", (req, res) => {
  const header = req.header("payment-signature");
  const orderId = header ? String(decodePaymentSignatureHeader(header).accepted.extra.orderId) : undefined;
  if (!orderId) return void res.status(400).json({ error: "missing order" });

  const symbol = String(req.query.symbol ?? "XRP").toUpperCase();
  const cheat = req.query.mode === "cheat" || process.env.SELLER_MODE === "cheat";
  const quote = cheat
    ? { symbol, price: -1, asOf: "2019-01-01T00:00:00Z", note: "trust me" }
    : { symbol, price: demoPrice(symbol), asOf: new Date().toISOString() };
  const body = JSON.stringify(quote);
  const signed = signDelivery(sellerWallet, orderId, body);

  console.log(`order ${orderId}: delivered ${cheat ? "a CHEAT" : "an honest"} quote`);
  emit({ type: "delivered", source: "seller", orderId, detail: { mode: cheat ? "cheat" : "honest", body: quote } });
  res
    .status(200)
    .setHeader(DELIVERY_SIGNATURE_HEADER, signed.signature)
    .setHeader(DELIVERY_PUBLIC_KEY_HEADER, signed.publicKey)
    .setHeader("Access-Control-Expose-Headers", `${DELIVERY_SIGNATURE_HEADER}, ${DELIVERY_PUBLIC_KEY_HEADER}, PAYMENT-RESPONSE`)
    .type("application/json")
    .send(body);
});

/** A plausible, slightly moving demo price. Not market data. */
function demoPrice(symbol: string): number {
  const base = symbol === "XRP" ? 2.4 : symbol === "BTC" ? 104_000 : 100;
  return Number((base * (1 + Math.sin(Date.now() / 60_000) * 0.01)).toFixed(4));
}

app.listen(PORTS.seller, () => {
  console.log(`seller on http://localhost:${PORTS.seller} (payTo ${sellerWallet.classicAddress}, ${PRICE_DROPS} drops per quote)`);
});

# x402-auth-capture-xrpl

The XRP Ledger binding of the x402 [`auth-capture`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth_capture.md) payment scheme, as a mechanism package for [`@x402/core`](https://www.npmjs.com/package/@x402/core): **verify-then-pay for HTTP APIs and AI agents.**

A buyer's payment is locked in a native XRPL escrow before the seller responds. An independent verifier (the *arbiter*) releases it to the seller only if the delivery passes. Otherwise the escrow expires and the funds can only return to the buyer. No smart contract is involved.

> **Pre-release (0.x).** Tested on XRPL testnet only and not audited. Interfaces may change.

## Install

```bash
npm install x402-auth-capture-xrpl @x402/core
```

Requires Node.js 22 or later and `@x402/core` 2.28 or later.

## What's included

| Export | Role |
| --- | --- |
| `AuthCaptureXrplClientScheme`, `XrplWalletSigner` | Buyer: signs an `EscrowCreate` under the buyer's policy (trusted arbiters, lock window, fee cap, balance pre-flight) |
| `AuthCaptureXrplServerScheme`, `HttpArbiterClient` | Seller: issues the 402 with an arbiter order, locks the escrow before the handler runs |
| `AuthCaptureXrplFacilitator`, `InMemorySettlementCache` | Facilitator: verifies the signed escrow, settles it, guards against duplicate settlement |
| `buildEscrowFinish`, `buildEscrowCancel`, `getEscrowState`, `ReclaimWatcher` | Escrow lifecycle: release, refund, state lookups, automatic refunds after the deadline |
| `signReceipt`, `verifyReceipt`, `signDelivery`, `verifyDelivery` | Signed arbiter verdicts and seller-signed deliveries |

## Quick start (buyer)

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { AuthCaptureXrplClientScheme, XrplWalletSigner } from "x402-auth-capture-xrpl";

const scheme = new AuthCaptureXrplClientScheme(new XrplWalletSigner(process.env.BUYER_SEED!), {
  trustedArbiters: ["rArbiterAddress..."],
  maxLockSeconds: 600,
});

const client = new x402Client()
  .register("xrpl:1", scheme)
  .setSpendControls({
    maxAmountPerPayment: false,
    allowedAssets: [{ network: "xrpl:1", asset: "XRP", maxAmountPerPayment: "2000000" }],
  });

const response = await wrapFetchWithPayment(fetch, client)("https://api.example.com/quote?symbol=XRP");
```

Seller and facilitator examples, the HTTP interfaces, the security model and the limitations are in the [repository README](https://github.com/Meredithhelipigeon/x402-xrpl-auth-capture#readme). The wire format and verification rules are in the [binding specification](https://github.com/Meredithhelipigeon/x402-xrpl-auth-capture/blob/main/specs/scheme_auth_capture_xrpl.md).

## License

Apache-2.0. Built on `@x402/core` and XRPL Japan's [`@xrpljapan/x402-xrpl`](https://github.com/xrpljapan/x402-xrpl).

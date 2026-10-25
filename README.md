# x402 `auth-capture` on XRPL

Verify-then-pay for AI agents on the XRP Ledger. The buyer's payment is locked in a native XRPL Escrow, an independent arbiter checks the delivery, and the arbiter releases the escrow on PASS. On FAIL, or if nobody acts, the escrow expires and the buyer takes the money back.

This repo is an XRPL network binding of the x402 [`auth-capture`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth_capture.md) scheme, plus demo apps. It is our entry for the AI & Fintech XRPL Hackathon (New York, Oct 24-25, 2026), Agentic Finance track.

- **Spec:** [`specs/scheme_auth_capture_xrpl.md`](./specs/scheme_auth_capture_xrpl.md). It answers the scheme's 8 binding requirements.
- **Design and milestones:** [`AGENTS.md`](./AGENTS.md). **Decisions:** [`DECISIONS.md`](./DECISIONS.md). **Pitch:** [`docs/pitch.md`](./docs/pitch.md).

## What this repo contributes

We built the XRP Ledger binding of x402's `auth-capture` scheme: a spec, an SDK for buyers, sellers and facilitators, and a live facilitator. With them, an agent's payment waits in a native XRPL escrow until a verifier such as Misa says the data checks out.

| Contribution | What it is | Where | Who uses it | Status (2026-10-25) |
| --- | --- | --- | --- | --- |
| XRPL binding spec | How `auth-capture` (lock first, pay after verification) works on the XRP Ledger. Answers all 8 requirements every binding must specify. | [`specs/scheme_auth_capture_xrpl.md`](./specs/scheme_auth_capture_xrpl.md) | Anyone implementing XRP escrow payments, in any language | Draft; not yet proposed to [x402-foundation/x402](https://github.com/x402-foundation/x402) |
| Buyer client | Signs an `EscrowCreate` that locks the price. Refuses untrusted arbiters, lock windows that are too short or too long, non-XRP assets, and balances that can't cover the payment. | [`client/`](./packages/auth-capture-xrpl/src/client/) | AI agents paying in XRP, including to Misa | Working on testnet |
| Facilitator scheme | Checks the buyer's signed escrow against 13 rules, submits it, waits for validation, and blocks double settlement. | [`facilitator/`](./packages/auth-capture-xrpl/src/facilitator/) | Facilitator operators | Working on testnet |
| Seller scheme | Issues the 402 with a fresh arbiter order, locks the escrow before the handler runs, and records funding with the arbiter. | [`server/`](./packages/auth-capture-xrpl/src/server/) | Sellers charging in XRP directly, without Misa | Working on testnet |
| Escrow lifecycle | Builders for release (`EscrowFinish`) and refund (`EscrowCancel`), escrow state lookups, and a watcher that refunds expired escrows automatically. | [`lifecycle/`](./packages/auth-capture-xrpl/src/lifecycle/) | Arbiters and facilitators | Working on testnet |
| Arbiter interface and signed receipts | A pluggable judge API (create order, record funding, submit delivery), signed verdicts, and seller-signed deliveries. | [`arbiter.ts`](./packages/auth-capture-xrpl/src/arbiter.ts), [`delivery.ts`](./packages/auth-capture-xrpl/src/delivery.ts) | Any verifier, Misa first | Working on testnet |
| Live facilitator | `/verify`, `/settle` and `/capture`, plus the refund watcher. It holds no funds and makes no decisions. | [`apps/facilitator`](./apps/facilitator), deployed at `https://x402-xrpl-auth-capture.onrender.com` | Misa's `xrplEscrow` payment adapter | Live, testnet only |
| End-to-end proof | Honest and cheating sellers on testnet, with balances checked to the drop: the seller gets exactly the price on PASS, and the buyer loses only the 12-drop network fee on FAIL. | [`scripts/e2e.ts`](./scripts/e2e.ts), [`scripts/raw-escrow.ts`](./scripts/raw-escrow.ts) | Reviewers and judges | Passed 3 rounds in a row from fresh wallets |
| Demo | A Claude buyer agent and a live dashboard showing the money move into escrow, then to the seller or back to the buyer. | [`apps/buyer-agent`](./apps/buyer-agent), [`apps/demo`](./apps/demo) | Hackathon presentation | Working; the agent's own run is pending an API key |

Built on [`@x402/core`](https://www.npmjs.com/package/@x402/core) and XRPL Japan's [`@xrpljapan/x402-xrpl`](https://github.com/xrpljapan/x402-xrpl) (Apache-2.0), whose `exact` XRPL binding this one follows. The package isn't on npm yet and this repository is still private.

## How it works

```mermaid
sequenceDiagram
  participant B as Buyer agent
  participant S as Seller API
  participant F as Facilitator
  participant A as Arbiter
  participant L as XRPL
  B->>S: GET /quote
  S->>A: create order (fresh secret)
  S-->>B: 402: pay into escrow, condition, deadline
  B->>S: retry with signed EscrowCreate
  S->>F: settle
  F->>L: EscrowCreate (money locked)
  S-->>B: quote, signed by the seller
  B->>A: here is what I got
  alt PASS
    A->>L: EscrowFinish (seller paid)
  else FAIL or no answer
    F->>L: EscrowCancel after the deadline (buyer refunded)
  end
  A-->>B: signed receipt
```

Nothing is deployed on-ledger. The guarantees come from XRPL consensus:
- The escrow can pay only `payTo`, and only with the arbiter's secret, before the deadline.
- After the deadline, anyone can return it to the buyer.

The facilitator holds no keys and no funds.

## Packages and apps

| Path | What it is |
| --- | --- |
| `packages/auth-capture-xrpl` | The mechanism package for `@x402/core`: client, server and facilitator schemes, the Arbiter interface and HTTP client, signed receipts and deliveries, and lifecycle helpers including the `ReclaimWatcher`. |
| `apps/facilitator` | `/supported`, `/verify`, `/settle`, `/capture` (submits the EscrowFinish for an arbiter that holds the fulfillment but no XRPL key, such as Misa), plus the watcher that refunds expired escrows. |
| `apps/arbiter-stub` | The Arbiter HTTP API. It holds the preimage and finishes on PASS. Misa's checks decide the verdict against the seller's Misa listing (`POST /x/{slug}/checks`, set `MISA_CHECKS_URL`); without it, a local stand-in runs the same body checks. |
| `apps/seller` | A paid `GET /quote`; `?mode=cheat` returns a bad quote. |
| `apps/buyer-agent` | Claude with one tool, `buy_quote`. |
| `apps/demo` | A live timeline with explorer links and honest/cheat buttons. |

## Run it

Requires Node 22+ and pnpm 10. Testnet only.

```bash
pnpm install
pnpm check                  # lint, typecheck, build, test
pnpm testnet:setup          # fund buyer, seller, arbiter, facilitator wallets; writes .env
```

Start the four services in separate terminals, then open http://localhost:4050:

```bash
pnpm demo
pnpm facilitator
pnpm arbiter
pnpm seller
```

The arbiter judges each quote against the seller's published response schema (`GET /openapi.json` on the seller). The order's terms only name the seller's Misa listing and action (`{ slug, operation_id }`), so nobody can swap the schema per order. Set `MISA_CHECKS_URL=https://api.trymisa.com` in `.env` to have Misa check against the schema it froze when the seller listed; leave it unset and the local stand-in reads the seller's `/openapi.json` itself.

Then run any of these:

```bash
pnpm testnet:e2e all        # honest + cheat end to end, balances checked to the drop (~4 min)
pnpm agent honest           # Claude buys a quote (needs ANTHROPIC_API_KEY)
pnpm agent cheat
pnpm testnet:raw-escrow     # M1: ledger-only proof of create/finish/cancel
pnpm testnet:settle-escrow  # M3/M4: a client-signed escrow through the facilitator
pnpm testnet:reclaim-expired  # cancel any of the buyer's escrows past their deadline
```

Wallet seeds live in `.env` (gitignored). Never commit or print them.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

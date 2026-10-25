# x402 `auth-capture` on XRPL — build brief

Read this whole file before writing code. It is the source of truth for scope, design and order of work. When something here conflicts with your instinct, follow this file and raise the question in chat.

## 0. What we are building

x402 on the XRP Ledger today only supports pay-first (`exact`): the buyer's money reaches the seller before anyone checks what was delivered. We are adding **verify-then-pay** to x402 on XRPL:

1. The buyer agent's payment is locked in a **native XRPL Escrow** (no smart contract to deploy).
2. The seller delivers.
3. An independent **arbiter** checks the delivery. On PASS the arbiter releases the escrow to the seller. On FAIL, or if nobody acts, the escrow expires and the buyer takes the money back.

Concretely, this repo ships an **XRPL network binding of the official x402 `auth-capture` scheme**, implemented as a TypeScript mechanism package for `@x402/core`, plus demo apps. The arbiter is pluggable; **Misa** is the first arbiter, but this repo must not depend on any Misa code. An arbiter stub lives here so everything runs end to end.

Context: this is our entry for the AI & Fintech XRPL Hackathon in New York (Oct 24–25, 2026), Agentic Finance track. Ship a working testnet demo first; polish second.

## 1. Background you need (read the sources, don't guess)

- **x402 v2 core spec**: `specs/x402-specification-v2.md` in `x402-foundation/x402`. Section 6.1 defines `extra.assetTransferMethod` and `extra.paymentFlow` (`authorization` | `upfront` | `escrow`). In the `escrow` flow the ordering is settle → resource → settle; the first settle places the hold.
- **`auth-capture` scheme** (network-agnostic): `specs/schemes/auth-capture/scheme_auth_capture.md`. Lifecycle ops: `authorize`, `charge`, `capture`, `void`, `refund`, `reclaim`. Its appendix lists 8 things every network binding MUST specify; our spec doc must answer all 8.
- **`auth-capture` EVM binding**: `specs/schemes/auth-capture/scheme_auth_capture_evm.md`. Copy its concepts, not its contracts. The parts we mirror: `operatorType: "custom"` (facilitator relays only the collect; lifecycle runs out of band through the operator) and `captureMode: "deferred"` (after-handler settle is skipped; capture happens later).
- **`exact` XRPL binding**: `specs/schemes/exact/scheme_exact_xrpl.md`. Our collect step is this binding with `Payment` replaced by `EscrowCreate`. Reuse its conventions: `signedTxBlob` payload, `assetTransferMethod` `sequence` / `ticketSequence`, network-binding rules, `areFeesSponsored: false`, and the REQUIRED duplicate-settlement mitigation.
- **Reference implementation to imitate**: `@xrpljapan/x402-xrpl` (npm 0.1.0, Apache-2.0, repo `xrpljapan/x402-xrpl`). ~700 lines implementing `exact` as `@x402/core` plugins (`SchemeNetworkServer` / `SchemeNetworkClient` / `SchemeNetworkFacilitator`), plus an Express facilitator example in `examples/multichain/`. Mirror its file layout and style. You may import its exported helpers (`networks`, `signer`, `asset`, account-view types). If you adapt non-exported code, keep the Apache-2.0 header and add a line to `NOTICE`.
- **XRPL Escrow docs**: xrpl.org → Escrow concept, `EscrowCreate`, `EscrowFinish`, `EscrowCancel`, and the conditional-escrow tutorial.

Get the specs with a sparse clone:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/x402-foundation/x402 vendor/x402
git -C vendor/x402 sparse-checkout set specs
```

(`vendor/` is gitignored; it is for reading only.)

## 2. Design decisions (locked for v0)

| Topic | Decision |
|---|---|
| Scheme | `auth-capture` (official core scheme). We add the XRPL binding. |
| Networks | `xrpl:1` (testnet) for everything now. Code must also accept `xrpl:0` (mainnet), but never run against mainnet without Meredith's explicit OK. Use separate XRPL accounts per network: a signed blob carries no `NetworkID` for networks with id ≤ 1024, so a testnet signature replays on mainnet if the same account and sequence exist there. |
| Asset | Native XRP only (`asset: "XRP"`, `amount` in drops). IOU/RLUSD is out of scope for v0. |
| Payment flow | `escrow` only. |
| Hold mechanism | Native `EscrowCreate` with a PREIMAGE-SHA-256 crypto-condition and `CancelAfter`. |
| Operator model | `operatorType: "custom"`: facilitator relays **only** the collect (`authorize` = submit `EscrowCreate`). Capture and reclaim run out of band. |
| Capture | Arbiter (holder of the preimage) submits `EscrowFinish` with the fulfillment. Full amount only. |
| Capture mode | `captureMode: "deferred"` (mandatory for collect-only routes, as in the EVM binding). |
| Reclaim | After `CancelAfter`, anyone submits `EscrowCancel`; funds return to the buyer. A watcher does it automatically. |
| Not supported | `void` (XRPL cannot cancel before expiry), partial capture, `charge`, `refund` after capture, fee split. Declare these unsupported; never fake them. |
| Asset transfer method | `sequence` (default). `ticketSequence` is a stretch goal. |
| Fees | Payer pays the `EscrowCreate` network fee (`areFeesSponsored: false`). Arbiter pays the `EscrowFinish` fee. Whoever reclaims pays the `EscrowCancel` fee. |
| Request binding | The per-order `condition` is unique, so it binds the escrow to the order. `EscrowCreate` has no `InvoiceID`; do not use `Memos`. |
| Language/stack | TypeScript, Node ≥ 22, pnpm workspace, `tsup`, `vitest`. |
| Visibility | Private repo. Never make it public without Meredith's OK. |

Anything that changes this table, the wire format in §3, or how money moves is Meredith's decision: ask, and keep working on what doesn't depend on the answer.

## 3. Wire format

### 3.1 `PaymentRequirements` (one `accepts[]` entry)

```json
{
  "scheme": "auth-capture",
  "network": "xrpl:1",
  "amount": "1000000",
  "asset": "XRP",
  "payTo": "rSELLER...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "paymentFlow": "escrow",
    "assetTransferMethod": "sequence",
    "areFeesSponsored": false,
    "operatorType": "custom",
    "captureAuthorizer": "rARBITER...",
    "captureMode": "deferred",
    "orderId": "ord_7f3c...",
    "condition": "A0258020<64 hex>810120",
    "captureDeadline": 1761330000
  }
}
```

| `extra` field | Required | Meaning |
|---|---|---|
| `paymentFlow` | Yes (write it out) | Always `"escrow"`. |
| `assetTransferMethod` | No | `"sequence"` (default) or `"ticketSequence"`. |
| `areFeesSponsored` | Yes | Always `false`. |
| `operatorType` | Yes (write it out) | Always `"custom"`. |
| `captureAuthorizer` | Yes | XRPL classic address of the arbiter. It holds the preimage and signs receipts. |
| `captureMode` | Yes (write it out) | Always `"deferred"`. |
| `orderId` | Yes | Arbiter's order id. Per-402, dynamic. |
| `condition` | Yes | Hex PREIMAGE-SHA-256 condition, 78 hex chars, uppercase. Per-402, dynamic. |
| `captureDeadline` | Yes | Absolute Unix seconds. Escrow `CancelAfter` = `captureDeadline − 946684800`. Per-402, dynamic. |

No `refundDeadline`, `feeRecipient`, `minFeeBps`, `maxFeeBps`: refunds and fees are unsupported on this binding.

### 3.2 `PaymentPayload.payload`

```json
{ "signedTxBlob": "120001..." }
```

Hex of a fully signed `EscrowCreate`:

```
TransactionType: EscrowCreate
Account:         <payer>
Destination:     <payTo>
Amount:          <amount, drops string>
Condition:       <extra.condition>
CancelAfter:     <captureDeadline − 946684800>
Sequence:        <payer's current sequence>   (or Sequence 0 + TicketSequence)
Fee:             <autofilled, ≤ facilitator policy>
LastLedgerSequence: <current ledger + ledgerBufferFromTimeout(maxTimeoutSeconds)>
```

No `FinishAfter`, `DestinationTag`, `Memos`, `Delegate`, `Signers`, or non-zero `Flags`.

### 3.3 Collect `SettleResponse`

Standard x402 fields: `success`, `transaction` (tx hash), `network`, `payer`, `amount`. No new fields. The escrow's identity is `(owner = payer Account, offerSequence = Sequence, or TicketSequence if a ticket was used)`, and anyone holding the blob can derive it.

### 3.4 Lifecycle (out of band, never through `/settle`)

- **Capture**: `EscrowFinish { Owner, OfferSequence, Condition, Fulfillment }`, submitted by the arbiter, before `CancelAfter`.
- **Reclaim**: `EscrowCancel { Owner, OfferSequence }`, submitted by anyone, after `CancelAfter`.

## 4. Repo layout

```
.
├── AGENTS.md                      this file
├── CLAUDE.md                      one line: @AGENTS.md
├── DECISIONS.md                   decisions + date + who made them
├── LICENSE                        Apache-2.0 (kept even while private)
├── NOTICE
├── package.json / pnpm-workspace.yaml / tsconfig.base.json
├── packages/
│   └── auth-capture-xrpl/         the mechanism package (the thing we upstream later)
│       └── src/
│           ├── index.ts
│           ├── types.ts           extra/payload types, constants, error codes
│           ├── condition.ts       preimage → condition/fulfillment
│           ├── time.ts            unix ⇄ ripple time
│           ├── delivery.ts        sign/verify a seller delivery
│           ├── arbiter.ts         Arbiter interface + HTTP client
│           ├── client/scheme.ts       AuthCaptureXrplClientScheme
│           ├── server/scheme.ts       AuthCaptureXrplServerScheme
│           ├── facilitator/scheme.ts  AuthCaptureXrplFacilitator
│           └── lifecycle/         buildEscrowFinish, buildEscrowCancel, getEscrowState, ReclaimWatcher
├── apps/
│   ├── facilitator/               Express: /supported /verify /settle + reclaim watcher
│   ├── arbiter-stub/              Express: implements the Arbiter HTTP API (Misa replaces this)
│   ├── seller/                    Express paid API with honest/cheat modes
│   ├── buyer-agent/               LLM agent that pays via x402
│   └── demo/                      timeline UI with testnet explorer links
├── scripts/
│   ├── setup-testnet.ts           fund wallets from faucet, write .env
│   ├── raw-escrow.ts              ledger-only proof: create→finish, create→cancel
│   └── e2e.ts                     honest + cheat scenarios end to end
└── specs/
    └── scheme_auth_capture_xrpl.md   binding spec draft
```

Dependencies (package): peer `@x402/core` `>=2.28.0`; deps `xrpl` `^5.3.0`, `@xrpljapan/x402-xrpl` `^0.1.0`. Dev: `five-bells-condition` (test vectors only), `vitest`, `tsup`, `typescript`. Apps add `express`, `@x402/express`, `@x402/fetch` (2.28.x), `@anthropic-ai/sdk` (buyer agent), `dotenv`.

## 5. Package modules

### 5.1 `condition.ts`

For a 32-byte preimage (always 32, from a CSPRNG):

```
condition   = "A0258020" + SHA256(preimage) + "810120"
fulfillment = "A0228020" + preimage
```

Uppercase hex. This manual DER encoding was checked to match `five-bells-condition` byte for byte; keep a unit test that compares against the library. Export `newPreimage()`, `conditionFromPreimage()`, `fulfillmentFromPreimage()`, `isWellFormedCondition()`. Never reuse a preimage.

### 5.2 `time.ts`

`RIPPLE_EPOCH_OFFSET = 946684800`. `toRippleTime(unixSeconds)`, `fromRippleTime(rippleSeconds)`. (xrpl.js's `unixTimeToRippleTime` takes **milliseconds**; don't mix them up.)

### 5.3 `arbiter.ts`

```ts
export interface ArbiterOrder {
  orderId: string;
  condition: string;
  captureDeadline: number;   // unix seconds
  captureAuthorizer: string; // arbiter classic address
}

export interface ArbiterReceipt {
  orderId: string;
  verdict: "PASS" | "FAIL";
  reason?: string;
  escrow?: { owner: string; offerSequence: number };
  finishTxHash?: string;     // set when PASS and EscrowFinish validated
  deliveryHash?: string;
  issuedAt: number;
  signer: string;            // arbiter classic address
  signature: string;         // over the canonical JSON of the fields above
}

export interface Arbiter {
  createOrder(i: { network: string; payTo: string; amount: string; asset: string; resource: string; terms?: unknown }): Promise<ArbiterOrder>;
  getOrder(orderId: string): Promise<(ArbiterOrder & { status: string }) | undefined>;
  recordFunding(i: { orderId: string; owner: string; offerSequence: number; txHash: string }): Promise<void>;
  submitDelivery(i: { orderId: string; body: string; sellerSignature: string; submittedBy: "buyer" | "seller" }): Promise<ArbiterReceipt>;
}
```

Also ship `HttpArbiterClient(baseUrl)` implementing `Arbiter` against the HTTP API in §7.2, and `verifyReceipt(receipt)`.

The fulfillment never leaves the arbiter. The arbiter submits `EscrowFinish` itself and reports the tx hash in the receipt.

### 5.4 `delivery.ts`

The seller signs what it delivers: `sha256(orderId + "\n" + body)` signed with the `payTo` wallet's key (`ripple-keypairs` `sign` / `verify`, which ships with `xrpl`). The seller returns the signature in the `X-DELIVERY-SIGNATURE` response header. The arbiter verifies it against `payTo`, so the buyer cannot forge a bad delivery, and the arbiter judges exactly the bytes the buyer received.

### 5.5 Client scheme: `AuthCaptureXrplClientScheme implements SchemeNetworkClient`

- `scheme = "auth-capture"`.
- `createPaymentPayload(2, req)`:
  1. Validate `extra` per §3.1 (flow, operatorType, captureMode, condition shape, captureAuthorizer address).
  2. **Buyer safety policy** (constructor options): `trustedArbiters: string[]` (reject an unknown `captureAuthorizer`), `maxLockSeconds` (reject if `captureDeadline − now` exceeds it), `minLockSeconds` (reject if the deadline is too close for the arbiter to act).
  3. Build the `EscrowCreate` in §3.2, autofill via a ledger client interface like the one in `@xrpljapan/x402-xrpl`'s client, sign with its `XrplSigner`, and return `{ x402Version: 2, payload: { signedTxBlob } }`.
  4. Optional pre-flight: balance ≥ amount + fee + one owner-reserve increment.

### 5.6 Server scheme: `AuthCaptureXrplServerScheme implements SchemeNetworkServer`

- `scheme = "auth-capture"`, `defaultAssetTransferMethod = "sequence"`, `paymentFlows = { sequence: { supported: ["escrow"], default: "escrow" }, ticketSequence: { supported: ["escrow"], default: "escrow" } }`.
- `dynamicExtraFields = ["orderId", "condition", "captureDeadline"]`. `@x402/core` drops these keys when it matches `accepted` against freshly built requirements, so the scheme must validate them itself (below).
- `parsePrice`: XRP only; accept an explicit drops amount or an `{ amount, asset: "XRP" }` shape. Reject `"$..."` dollar prices (no USD↔XRP oracle in v0).
- `enhancePaymentRequirements`: add the static `extra` fields.
- Per-402 dynamic fields: call `arbiter.createOrder(...)` when the 402 response is built (use the `enrichPaymentRequiredResponse` hook). **Confirm in `@x402/core`'s server source** which hook runs once per 402 response; never create an order on every requirements build.
- `schemeHooks.onBeforeSettle(ctx)`:
  - `phase === "before-handler"`: load the order by `accepted.extra.orderId`; require that `condition`, `captureDeadline`, `payTo`, `amount` match and that the order is unfunded; otherwise `{ abort: true, reason: "invalid_auth_capture_xrpl_order" }`.
  - `phase === "after-handler"`: return `{ skip: true, result: { success: true, transaction: "", network, payer } }`. This is deferred capture: nothing is settled after the handler.
- After a successful before-handler settle (`onAfterSettle`, or `enrichSettlementResponse` if that is the right hook in 2.28): decode the blob, derive `(owner, offerSequence)`, call `arbiter.recordFunding`.
- `settleOnCancel`: return nothing. If the handler fails, the escrow stays locked, the arbiter never finishes it, and it refunds at the deadline.
- `validateFacilitatorSupport`: require a supported kind `auth-capture` on the network whose `extra.operatorTypes` includes `"custom"`.

### 5.7 Facilitator scheme: `AuthCaptureXrplFacilitator implements SchemeNetworkFacilitator`

- `scheme = "auth-capture"`, `caipFamily = "xrpl:*"`.
- `getExtra()`: `{ areFeesSponsored: false, operatorTypes: ["custom"], captureModes: ["deferred"], assetTransferMethods: ["sequence"], maxLockSeconds }`.
- `getSigners()`: `[]`, since the facilitator signs nothing on the collect path.
- `verify`: run the rules in §6. Read-only.
- `settle`: re-run `verify` → duplicate guard (§6.13) → submit → wait for a validated result → require `tesSUCCESS` → return §3.3. Any lifecycle payload (`payload.type` present) → `invalid_auth_capture_xrpl_lifecycle_not_relayed`.

### 5.8 Lifecycle

- `buildEscrowFinish({ account, owner, offerSequence, condition, fulfillment })`. Let `client.autofill` set the fee; it already scales the fee for the fulfillment size.
- `buildEscrowCancel({ account, owner, offerSequence })`.
- `getEscrowState(client, owner, offerSequence)`: `ledger_entry` with `{ escrow: { owner, seq } }`. Found = `"held"`; not found = `"closed"` (finished or cancelled; check `account_tx` if you need which).
- `ReclaimWatcher`: keeps the set of funded escrows; once ledger close time is past `CancelAfter` + margin, submits `EscrowCancel`; emits events.

## 6. Facilitator verification rules (MUST, in order)

Error codes use the prefix `invalid_auth_capture_xrpl_…`.

1. **Envelope**: `x402Version === 2`; `accepted.scheme === "auth-capture"`; `accepted.network === requirements.network` and is `xrpl:0` or `xrpl:1`; the selected `assetTransferMethod` follows the `exact` XRPL resolution rules.
2. **`extra`**: `paymentFlow === "escrow"`, `operatorType === "custom"`, `captureMode === "deferred"`, `areFeesSponsored === false`; `condition` well-formed; `captureAuthorizer` a valid classic address; `captureDeadline` an integer in `[now + minLock, now + maxLock]`.
3. **Decode** `signedTxBlob` → `TransactionType === "EscrowCreate"`.
4. **Destination** `=== payTo`; no `DestinationTag`.
5. **Amount** is a string of drops `=== requirements.amount`.
6. **Condition** `=== extra.condition` (case-insensitive).
7. **`CancelAfter`** `=== captureDeadline − 946684800`; `FinishAfter` absent.
8. **Network binding**: same as `exact` XRPL §5 (`NetworkID` omitted for id ≤ 1024; submit only to the requested network).
9. **Sequencing/expiry**: `LastLedgerSequence` present and ≤ current ledger + `ledgerBufferFromTimeout(maxTimeoutSeconds)`; `sequence` → `Sequence` equals the account's current sequence; `ticketSequence` → `Sequence === 0` and the ticket exists.
10. **Safety**: `Fee` ≤ policy max; reject `Memos`, `Delegate`, `Signers`, non-zero `Flags`.
11. **Signature** valid (`verifySignature` from `xrpl`); signer is `Account`.
12. **Accounts**: payer balance ≥ amount + fee + one owner-reserve increment; destination exists (else `tecNO_DST`) and does not have `DepositAuth` or `RequireDest` set.
13. **Duplicate settlement (settle only)**: atomic check-and-record keyed on the tx hash; keep the key until `LastLedgerSequence` has passed; on hit → `duplicate_settlement`. This is copied from the `exact` XRPL binding and is REQUIRED: XRPL returns the same success to every resubmission of a known blob.

Map ledger results (`tecUNFUNDED`, `tecNO_DST`, `tecNO_PERMISSION`, `tecINSUFFICIENT_RESERVE`, `tefPAST_SEQ`, …) to x402 error reasons.

## 7. Demo apps

### 7.1 `apps/facilitator`

Express, modelled on `@xrpljapan/x402-xrpl`'s `examples/multichain/src/facilitator.ts`: `new x402Facilitator().register(["xrpl:1"], new AuthCaptureXrplFacilitator(...))`, routes `/supported`, `/verify`, `/settle`. Also runs a `ReclaimWatcher` with its own funded wallet. Emits events to the demo bus (§7.6).

### 7.2 `apps/arbiter-stub`

HTTP API (Misa will implement the same API later):

- `POST /orders` → `ArbiterOrder` (random 32-byte preimage per order; store in memory or a JSON file).
- `GET /orders/:id` → order + status (`created | funded | passed | failed | finished | reclaimed`).
- `POST /orders/:id/funding` → record `owner`, `offerSequence`, `txHash`.
- `POST /orders/:id/delivery` → verify the seller signature against `payTo`; judge; on PASS submit `EscrowFinish` from the arbiter wallet, wait for validation; return a signed `ArbiterReceipt`.
- Judging rule: the order's `terms` are the seller's published promise in Misa's `AnswerPromise` shape (`{ version: 1, response_schema, max_latency_ms }`). Misa's `POST /v1/checks` judges the body against it when `MISA_CHECKS_URL` is set; otherwise a local stand-in runs the same body checks (JSON, matches the schema, not empty). The arbiter keeps the preimage and the escrow either way; anything but a verdict from Misa is a FAIL.
- If two different seller-signed bodies arrive for the same order → FAIL (seller equivocation).

### 7.3 `apps/seller`

Express + `@x402/express` with `AuthCaptureXrplServerScheme` registered for `xrpl:1`. One paid route, e.g. `GET /quote?symbol=XRP` at 1 XRP. `?mode=cheat` (or an env flag) returns garbage. Every response is signed per §5.4 with the delivery signature in `X-DELIVERY-SIGNATURE`.

### 7.4 `apps/buyer-agent`

Claude via `@anthropic-ai/sdk` with one tool, `buy_quote(symbol)`. The tool uses `@x402/fetch` with `AuthCaptureXrplClientScheme` registered (`trustedArbiters = [arbiter address]`, `maxLockSeconds = 600`), then forwards the received body + signature to the arbiter (`submittedBy: "buyer"`) and prints the receipt. Hard spend cap per run. Follow `examples/multichain/src/client.ts` in `@xrpljapan/x402-xrpl` for wiring.

### 7.5 `apps/demo`

A single page fed by server-sent events: a timeline per order (402 issued → escrow locked → delivered → verdict → finished / reclaimed), each step with a link to `https://testnet.xrpl.org/transactions/<hash>`, plus live balances for buyer and seller. Two buttons: "honest seller" and "cheating seller".

### 7.6 Event bus

The simplest thing that works: each app POSTs events to the demo server, which fans them out over SSE.

## 8. Testnet setup

- Endpoint: `wss://s.altnet.rippletest.net:51233`. Explorer: `https://testnet.xrpl.org`.
- `scripts/setup-testnet.ts`: create and fund four wallets with `client.fundWallet()` (buyer, seller, arbiter, facilitator/watcher) and write `.env` (gitignored). Print the addresses and balances.
- Seeds live only in `.env`. Never commit, log, or print a seed after setup.

## 9. Tests and acceptance

Unit tests (offline, run in CI):
- Condition/fulfillment vectors match `five-bells-condition`.
- Ripple-time conversion.
- The client builds exactly the §3.2 transaction.
- The facilitator rejects each tampered field: one table-driven case per rule in §6.
- The duplicate guard is atomic under concurrent calls.
- Receipt and delivery sign/verify round-trip.

Testnet integration (opt-in, `XRPL_E2E=1`), using short deadlines (≈150 s):
- **Raw ledger** (`scripts/raw-escrow.ts`): conditional create → finish with fulfillment ✅; create → cancel after expiry ✅; finish with a wrong fulfillment fails (`tecCRYPTOCONDITION_ERROR`); finish after expiry fails; cancel before expiry fails.
- **E2E honest** (`scripts/e2e.ts`): the agent buys, the escrow is created, the delivery is judged PASS, `EscrowFinish` validates, and the seller's balance rises by the amount.
- **E2E cheat**: verdict FAIL, no finish; the watcher cancels after the deadline; the buyer's balance is back to start minus network fees.

**Demo-ready** means both E2E scenarios pass three times in a row from a clean `.env` and the demo page shows both timelines with working explorer links.

## 10. Milestones (in this order)

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold workspace, lint, build, test, CI | `pnpm build && pnpm test` green |
| M1 | `setup-testnet.ts` + `raw-escrow.ts` | All raw ledger checks in §9 pass on testnet |
| M2 | `condition`, `time`, `types`, `delivery`, lifecycle helpers | Unit tests green |
| M3 | Facilitator scheme + app + dedup | §6 tamper tests green; a real `EscrowCreate` settles on testnet |
| M4 | Client scheme | The blob it produces passes the facilitator's `verify` |
| M5 | Arbiter interface + HTTP client + arbiter-stub + server scheme + seller | `curl` the paid route → 402 with the §3.1 fields |
| M6 | `scripts/e2e.ts` honest + cheat | Both pass on testnet |
| M7 | Buyer agent | The agent completes both scenarios unattended |
| M8 | Demo page + event bus | Demo-ready per §9 |
| M9 | README, `specs/scheme_auth_capture_xrpl.md`, pitch notes | The spec answers the 8 binding requirements |
| Stretch | `ticketSequence`; XRPL Credentials (arbiter issues a credential to verified sellers; buyer checks it before paying); IOU/RLUSD | |

M1 comes before any SDK code on purpose: it proves the ledger mechanics in an hour, and everything after it is plumbing.

### Spec doc outline (M9)

Follow `specs/scheme_impl_template.md` in the x402 repo. Answer the 8 binding requirements:
1. Hold: native Escrow. Capture = `EscrowFinish`, full amount. Deadline = `CancelAfter`. No void or refund.
2. Client authorization: presigned `EscrowCreate`; identity `(Account, Sequence | TicketSequence)`.
3. Operator: `"custom"`, collect-only relay; `captureAuthorizer` = arbiter holding the preimage; lifecycle out of band.
4. Server consent: no lifecycle is relayed; the capture right is the fulfillment, held by the arbiter.
5. Replay: the ledger consumes each escrow once; collect dedup by tx hash.
6. Per-operation verification: §6.
7. Refund funding: refunds unsupported; reclaim only.
8. Sync capture-and-void: unsupported; `captureMode` MUST be `"deferred"`.

## 11. XRPL gotchas

- `CancelAfter` and `FinishAfter` compare against the **parent ledger close time**, which has coarse resolution (up to ~10 s). `EscrowFinish` works only while close time < `CancelAfter`; `EscrowCancel` only once close time > `CancelAfter`. Keep ≥ 20 s margins in tests and in the watcher.
- Each open escrow adds one owner-reserve increment to the payer until it closes. The buyer needs spare XRP.
- `OfferSequence` is the `EscrowCreate`'s `Sequence`, or its `TicketSequence` if a ticket was used.
- Anyone can submit `EscrowFinish` (with the right fulfillment) or `EscrowCancel` (after expiry). The fulfillment, and therefore the preimage, becomes public once a finish validates; that is fine because the escrow is gone.
- `EscrowFinish` with a fulfillment costs more than the base fee; `client.autofill` computes it.
- `EscrowCreate` to an unfunded destination fails `tecNO_DST`; fund the seller first.
- Submitting the same signed blob twice returns success twice. That is why §6.13 exists.

## 12. Out of scope for v0

Mainnet; IOU/RLUSD; `void`, partial capture, `charge`, `refund`; fee splitting; Smart Escrows (XLS-100, devnet only); upstream PRs; any Misa code. Note ideas in `DECISIONS.md` under "Later".

## 13. Working rules

- Keep the repo private. No secrets in git (`.env*` and `vendor/` gitignored).
- Testnet only unless Meredith says otherwise in chat.
- Every change lands through a pull request: work on a branch, open a PR against `main`, and never push to `main` directly. Meredith reviews and merges.
- Small commits with clear messages; keep `main` green; run `pnpm check` before every push.
- Record every non-obvious choice in `DECISIONS.md` (date, choice, reason, who decided).
- When this file and an x402 spec disagree, the spec wins for wire-level behavior; flag it.
- When stuck on an `@x402/core` hook's exact behavior, read its source in `node_modules/@x402/core/dist` rather than guessing, and write down what you found.
- Report progress in short messages: what works now, what's next, and anything needing a decision. Start each decision request with "**Decision needed:**".

# Auth-Capture Payment Scheme for XRP Ledger (XRPL) (`auth-capture`)

> Status: **draft**. XRPL network binding of the network-agnostic
> [`scheme_auth_capture.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth_capture.md),
> alongside the EVM binding `scheme_auth_capture_evm.md`.

## Summary

This binding realizes `auth-capture` on the XRP Ledger with a native **conditional
Escrow**. It is the *full-capture-only profile* of the scheme: the client authorizes an
exact amount, the hold is captured in full or reclaimed after the deadline, and nothing
in between.

The client signs an `EscrowCreate` locking `amount` drops to `payTo`, guarded by a
PREIMAGE-SHA-256 crypto-condition and a `CancelAfter` deadline. The facilitator relays
only that collect. The preimage is held by an independent **capture authorizer** (an
arbiter). It releases the escrow with `EscrowFinish` once it accepts what the resource
server delivered. If it never does, anyone may submit `EscrowCancel` after the deadline,
and the funds can only return to the client.

Use cases: verify-then-pay for agents buying data or work, where the seller is paid only
after an independent check of the delivery; delayed delivery with buyer recourse.

No smart contract is deployed. Every guarantee below is enforced by XRPL consensus.

## Scheme Name

`auth-capture`

## Network Identifier (CAIP-2)

`xrpl:0` (mainnet) and `xrpl:1` (testnet). Both have network ids ≤ 1024, so `NetworkID`
MUST be omitted from the signed transaction and the facilitator MUST submit only to the
requested network. As in `exact` XRPL §5, an omitted `NetworkID` is not a cross-network
replay guarantee: clients SHOULD use different accounts per network.

## Asset

Native XRP only: `asset` is `"XRP"` and `amount` is a string of drops. Issued currencies
are out of scope for this profile.

## Payment flow

`escrow` only (settle → resource → settle).

| Step | `auth-capture` operation | XRPL | Who |
| --- | --- | --- | --- |
| Before the handler | `authorize` | `EscrowCreate` (presigned by the client), relayed by `/settle` | Facilitator |
| After the handler | — (deferred) | nothing | — |
| Later, out of band | `capture` | `EscrowFinish` with the fulfillment, before `CancelAfter` | Capture authorizer |
| After the deadline | `reclaim` | `EscrowCancel`, after `CancelAfter` | Anyone; funds go only to the client |

`captureMode` MUST be `"deferred"`. The resource server skips the after-handler settle,
and capture happens asynchronously when the authorizer accepts the delivery.

## `PaymentRequirements`

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
| --- | --- | --- |
| `paymentFlow` | Yes | `"escrow"`. |
| `assetTransferMethod` | No | `"sequence"` (default) or `"ticketSequence"`, resolved as in `exact` XRPL §7. |
| `areFeesSponsored` | Yes | `false`: the payer pays the `EscrowCreate` fee. |
| `operatorType` | Yes | `"custom"`: the facilitator relays only the collect. |
| `captureAuthorizer` | Yes | Classic address of the party holding the preimage. It signs receipts for its verdicts. |
| `captureMode` | Yes | `"deferred"`. |
| `orderId` | Yes | The capture authorizer's order id. Fresh on every 402. |
| `condition` | Yes | PREIMAGE-SHA-256 condition, 78 hex characters: `A0258020` ‖ SHA-256(preimage) ‖ `810120`. Fresh on every 402. |
| `captureDeadline` | Yes | Absolute Unix seconds. `CancelAfter = captureDeadline − 946684800`. Fresh on every 402. |

`orderId`, `condition` and `captureDeadline` are dynamic fields. A resource server MUST
treat them as part of the requirements the client paid against, not regenerate them on
the paid retry. `refundDeadline`, `feeRecipient`, `minFeeBps` and `maxFeeBps` are absent,
because refunds and fees are unsupported.

## `PaymentPayload`

```json
{ "x402Version": 2, "accepted": { "...": "the requirements above" }, "payload": { "signedTxBlob": "120001..." } }
```

`signedTxBlob` is the hex of a fully signed `EscrowCreate`:

| Field | Value |
| --- | --- |
| `TransactionType` | `EscrowCreate` |
| `Account` | payer |
| `Destination` | `payTo` |
| `Amount` | `amount` (drops string) |
| `Condition` | `extra.condition` |
| `CancelAfter` | `captureDeadline − 946684800` |
| `Sequence` | the payer's current sequence (or `0` with `TicketSequence`) |
| `Fee` | autofilled, at most the facilitator's policy maximum |
| `LastLedgerSequence` | current ledger + `ceil(maxTimeoutSeconds / 4)` |

`FinishAfter`, `DestinationTag`, `Memos`, `Delegate`, `Signers` and non-zero `Flags` MUST
be absent. The payment's identity is `(owner = Account, offerSequence = Sequence, or
TicketSequence if a ticket was used)`, derivable by anyone holding the blob.

Clients SHOULD refuse to sign unless `captureAuthorizer` is an authorizer they trust, and
unless `captureDeadline − now` falls inside their own lock window.

## Facilitator Verification Rules (MUST)

In order. Failure reasons use the prefix `invalid_auth_capture_xrpl_`.

1. **Envelope.** `x402Version === 2`; `accepted.scheme` and `requirements.scheme` are `auth-capture`; `accepted.network === requirements.network` ∈ {`xrpl:0`, `xrpl:1`}; the selected `assetTransferMethod` follows `exact` XRPL §7; `asset === "XRP"`.
2. **`extra`.** The constant fields above; `condition` well-formed; `captureAuthorizer` a valid classic address; `captureDeadline` an integer in `[now + minLock, now + maxLock]`; `orderId`, `condition`, `captureDeadline` and `captureAuthorizer` equal between `accepted.extra` and `requirements.extra`.
3. **Decode** `signedTxBlob`; `TransactionType === "EscrowCreate"`.
4. **Destination** `=== payTo`; no `DestinationTag`.
5. **Amount** is a string of drops `=== requirements.amount`.
6. **Condition** `=== extra.condition` (case-insensitive).
7. **`CancelAfter`** `=== captureDeadline − 946684800`; no `FinishAfter`.
8. **Network binding.** `NetworkID` absent.
9. **Sequencing and expiry.** `LastLedgerSequence` present, greater than the current validated ledger, and at most current + `ceil(maxTimeoutSeconds / 4)`. `sequence`: `Sequence` equals the account's current sequence and `TicketSequence` is absent. `ticketSequence`: `Sequence === 0` and the ticket exists.
10. **Safety.** `Fee` ≤ policy maximum; no `Memos`, `Delegate`, `Signers`; `Flags` is `0`.
11. **Signature.** Single-signed, `verifySignature` passes, and the signing key derives to `Account`, whose master key is not disabled.
12. **Accounts.** The payer's balance covers `amount` + `Fee` + the reserve after this escrow (base + increment × (OwnerCount + 1)). The destination exists and has neither `lsfDepositAuth` nor `lsfRequireDestTag` set.

Any payload carrying `payload.type` is a lifecycle operation, which this binding never
relays, and is refused with `invalid_auth_capture_xrpl_lifecycle_not_relayed`.

## Settlement

`/settle` re-runs verification. It then claims the transaction hash in the duplicate
settlement guard, submits the blob to the requested network, waits for a validated
result, and succeeds only on `tesSUCCESS`.

The `SettlementResponse` carries the standard fields: `success`, `transaction` (the
`EscrowCreate` hash), `network`, `payer` and `amount`. Ledger results map to reasons:
`tecUNFUNDED` and `tecINSUFFICIENT_RESERVE` map to `insufficient_funds`, `tecNO_DST` to
`destination_not_found`, `tefPAST_SEQ` to `sequence`, and so on.

### Duplicate Settlement Mitigation (REQUIRED)

Copied from `exact` XRPL. XRPL answers every resubmission of a known blob with the same
validated success. Facilitators MUST therefore check and record the transaction hash
atomically before submitting, retain it until `LastLedgerSequence` has passed (even after
a failed submit), and reject a hit with `duplicate_settlement`. Once a settlement
validates, the payer's sequence is consumed, so later resubmissions also fail rule 9.

## Capture and reclaim (out of band)

- **Capture**: the capture authorizer submits
  `EscrowFinish { Owner, OfferSequence, Condition, Fulfillment = A0228020 ‖ preimage }`
  while the parent ledger's close time is before `CancelAfter`. The authorizer pays its
  fee, which is higher than the base fee because of the fulfillment. After it validates
  the preimage is public, which is harmless because the escrow no longer exists.
- **Reclaim**: anyone submits `EscrowCancel { Owner, OfferSequence }` once close time is
  past `CancelAfter`. Funds can only return to `Owner`. A watcher run by the facilitator,
  the client or the authorizer makes this automatic.

Close time has coarse resolution (up to about 10 s). Implementations SHOULD keep margins
of about 20 s on both sides of the deadline.

## Appendix: the 8 network requirements

| # | Requirement | This binding |
| --- | --- | --- |
| 1 | Hold / settlement mechanism | Native conditional `EscrowCreate`. Capture = `EscrowFinish`, full amount only. The deadline is `CancelAfter`, enforced in consensus. No void, no refund. |
| 2 | Client authorization format | A presigned `EscrowCreate` in `signedTxBlob`. Identity `(Account, Sequence \| TicketSequence)`. |
| 3 | Operator model | `operatorType: "custom"`. The facilitator relays only `authorize`; capture is driven by `captureAuthorizer` (the preimage holder) and reclaim by anyone, both out of band. |
| 4 | Server consent | No lifecycle operation is relayed, so none needs server authentication. The right to capture is the fulfillment itself, held by the capture authorizer the client chose to trust. |
| 5 | Replay protection | The ledger consumes each escrow once (a second finish or cancel finds no object). The collect is deduplicated by tx hash, and the per-order condition binds one escrow to one order. |
| 6 | Per-operation verification and settlement | `authorize`: rules 1-12 above, then dedup, submit and validate. Capture and reclaim are validated by consensus (condition, deadline, owner). |
| 7 | Refund funding | Refunds are unsupported. Only `reclaim` returns funds, and those funds are the client's own hold, so the facilitator is never a source of value. |
| 8 | Sync capture-and-void | Unsupported: `captureMode` MUST be `"deferred"`. |

## Security Considerations

**Trust minimization.** The facilitator holds no key, signs nothing, holds no funds, and
cannot redirect a payment, because `Destination` is fixed in the signed blob. The capture
authorizer can choose only between paying `payTo` the full amount (by finishing) and
letting the escrow refund (by doing nothing). It can never send funds anywhere else.

**Trusting the authorizer.** The client trusts the authorizer to judge honestly, so the
client must pick it: refuse unknown `captureAuthorizer` addresses. A seller acting as its
own authorizer would make this equivalent to pay-first.

**Delivery binding.** Resource servers SHOULD sign the bytes they deliver (for example
SHA-256 of `orderId + "\n" + body` with the `payTo` key), so the authorizer judges
exactly what the client received and the client cannot forge a bad delivery.

**Reclaim is not exclusive to the client.** The core spec describes `reclaim` as the
client's escape hatch. On XRPL anyone may submit `EscrowCancel` after the deadline, and
the funds still go only to the owner, so letting a third party do it adds no risk.

## Limitations and Out of Scope

**No void before the deadline.** XRPL cannot cancel an escrow before `CancelAfter`, so a
rejected delivery refunds only at the deadline. Shorter deadlines shorten the wait but
leave the authorizer less time to judge.

**Full capture only.** An escrow finishes for its whole amount. Partial capture and
capture-and-void would need Payment Channels (the hold used by `upto` XRPL), where the
authorizer could hold the claim key.

**No refund after capture**, and no fee split: `EscrowFinish` pays `Destination` the full
amount.

**XRP only.** Issued-currency (`TokenEscrow`) holds are a natural extension, not
specified here.

**Owner reserve.** Each open escrow holds one owner-reserve increment on the payer until
it closes.

## Version History

| Version | Date | Changes |
| --- | --- | --- |
| v0.1 | 2026-10-24 | Initial draft (full-capture-only profile) |

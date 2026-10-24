# Decisions

Every non-obvious choice, newest first. Format: date, decision, reason, who decided.

## 2026-10-24

- **Facilitator accepts only Account's master key.** Rule 11 says "signer is `Account`", so a regular-key signature is refused (the `exact` reference allows it). A disabled master key is refused too, since the ledger would reject the tx. Who: Claude (default, following AGENTS.md section 6 literally).
- **Facilitator policy defaults: `minLockSeconds` 30, `maxLockSeconds` 3600, `maxFeeDrops` 2000.** 30 s covers ledger close-time coarseness plus one arbiter round trip; the testnet base fee is 10-12 drops. All three are constructor options. Who: Claude (default).
- **`LastLedgerSequence` bound is `current validated ledger + ledgerBufferFromTimeout(maxTimeoutSeconds)`,** using the reference package's helper (`ceil(t/4)`), as AGENTS.md section 6 rule 9 says. The `exact` spec recommends `ceil(t/5)+2`; both are policy, not wire format. Who: Claude (default).
- **Rule 13 dedup only matters for concurrent settles.** Once a settle validates, the payer's Sequence is consumed, so a later resubmission already fails rule 9 (`invalid_auth_capture_xrpl_sequence`) before the guard. Seen on testnet. Who: Claude (observation).
- **The facilitator app's watcher learns escrows from its own successful settles** (decoding the blob it just relayed), so nothing else needs to call `track`. The watched set is in memory; a restart forgets it, and anyone can still cancel expired escrows. Who: Claude (default).
- **Apps and scripts run the package from source** through a `source` export condition (`tsx --conditions=source`, `customConditions` in the apps' tsconfig), so `pnpm typecheck` and the demo don't need a build first. Published consumers still get `dist`. Who: Claude (default).

- **Delivery signature travels with its public key.** The seller returns `X-DELIVERY-SIGNATURE` and `X-DELIVERY-PUBLIC-KEY`; the arbiter checks that the key derives to `payTo`, then verifies the signature over sha256(orderId + "\n" + body). An address alone cannot verify a signature. Limitation: the seller must sign with its master key (a regular key derives a different address). Who: Claude (default); this is our own header, not x402 wire format.
- **Hold mechanism stays native XRPL Escrow (not payment channels).** Escrow's ledger mechanics are simpler to prove in M1, and the demo story (lock, verify, release or reclaim) is the same either way. Payment channels would raise `auth-capture` coverage to partial capture and capture-and-void (the arbiter can hold the channel's claim key), and are the v1 path. Who: Meredith (go-ahead in chat on Claude's recommendation).
- **Present the binding as the "full-capture-only profile" of `auth-capture`, not a new scheme.** It meets all 8 binding requirements and all core properties; void, partial capture and refund are declared unsupported because XRPL Escrow cannot do them. Merged bindings commonly declare unsupported features; follow the "Limitations and Out of Scope" format of `scheme_upto_xrpl.md`. Who: Meredith (in chat, after review).
- **Separate XRPL accounts per network.** A signed blob carries no `NetworkID` for networks with id <= 1024, so a testnet signature can replay on mainnet when the same account and sequence exist there. Added to AGENTS.md section 2. Who: Meredith (go-ahead in chat on Claude's recommendation).
- **Repo is private until submission.** Make it public before the Oct 25 submission only with Meredith's OK, after checking history for secrets. Who: Meredith.
- **TypeScript 5.9, not 7.** `typescript-eslint` supports TypeScript below 6.1, and tsup's declaration build uses the TypeScript JS API. Who: Claude (default).
- **Unix-seconds guard in `toRippleTime`.** Values of 10^10 or more are rejected as probable milliseconds, because xrpl.js's own helper takes milliseconds and mixing them up silently sets deadlines tens of thousands of years out. Who: Claude (default).
- **License copyright line reads "The x402-xrpl-auth-capture authors".** Neutral holder while the project's owning entity is undecided. Who: Claude (default); Meredith may change it.
- **PR descriptions follow the `raise-pr` skill.** The skill is kept as Meredith wrote it in `.claude/skills/raise-pr/`; the copy GitHub fills in, `.github/pull_request_template.md`, defines "the contract" for this repo as the x402 wire format (AGENTS.md section 3) and the Arbiter API that Misa implements (sections 5.3 and 7.2), since there is no `packages/core` here. Titles use the milestone as the work-item ID, e.g. `[M3]`. Who: Meredith (skill); Claude (default for the contract wording).

## Later

- Payment-channel hold (partial capture, capture-and-void).
- "Two exact payments through the arbiter" (custodial) as a Misa product option for RLUSD and partial refunds; custody may raise money-transmission licensing questions.
- A scheme-agnostic arbiter add-on, possibly aligned with x402's `extension-offer-and-receipt.md`.
- Ask x402 maintainers in a GitHub discussion before any upstream PR.

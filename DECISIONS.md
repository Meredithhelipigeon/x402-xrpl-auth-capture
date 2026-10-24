# Decisions

Every non-obvious choice, newest first. Format: date, decision, reason, who decided.

## 2026-10-24

- **Hold mechanism stays native XRPL Escrow (not payment channels).** Escrow's ledger mechanics are simpler to prove in M1, and the demo story (lock, verify, release or reclaim) is the same either way. Payment channels would raise `auth-capture` coverage to partial capture and capture-and-void (the arbiter can hold the channel's claim key), and are the v1 path. Who: Meredith (go-ahead in chat on Claude's recommendation).
- **Present the binding as the "full-capture-only profile" of `auth-capture`, not a new scheme.** It meets all 8 binding requirements and all core properties; void, partial capture and refund are declared unsupported because XRPL Escrow cannot do them. Merged bindings commonly declare unsupported features; follow the "Limitations and Out of Scope" format of `scheme_upto_xrpl.md`. Who: Meredith (in chat, after review).
- **Separate XRPL accounts per network.** A signed blob carries no `NetworkID` for networks with id <= 1024, so a testnet signature can replay on mainnet when the same account and sequence exist there. Added to AGENTS.md section 2. Who: Meredith (go-ahead in chat on Claude's recommendation).
- **Repo is private until submission.** Make it public before the Oct 25 submission only with Meredith's OK, after checking history for secrets. Who: Meredith.
- **TypeScript 5.9, not 7.** `typescript-eslint` supports TypeScript below 6.1, and tsup's declaration build uses the TypeScript JS API. Who: Claude (default).
- **Unix-seconds guard in `toRippleTime`.** Values of 10^10 or more are rejected as probable milliseconds, because xrpl.js's own helper takes milliseconds and mixing them up silently sets deadlines tens of thousands of years out. Who: Claude (default).
- **License copyright line reads "The x402-xrpl-auth-capture authors".** Neutral holder while the project's owning entity is undecided. Who: Claude (default); Meredith may change it.

## Later

- Payment-channel hold (partial capture, capture-and-void).
- "Two exact payments through the arbiter" (custodial) as a Misa product option for RLUSD and partial refunds; custody may raise money-transmission licensing questions.
- A scheme-agnostic arbiter add-on, possibly aligned with x402's `extension-offer-and-receipt.md`.
- Ask x402 maintainers in a GitHub discussion before any upstream PR.

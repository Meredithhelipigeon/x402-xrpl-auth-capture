# x402 `auth-capture` on XRPL

Verify-then-pay for AI agents on the XRP Ledger. The buyer's payment is locked in a native XRPL Escrow, an independent arbiter checks the delivery, and the arbiter releases the escrow on PASS. On FAIL, or if nobody acts, the escrow expires and the buyer takes the money back.

This repo is an XRPL network binding of the x402 [`auth-capture`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth_capture.md) scheme, plus demo apps. It is our entry for the AI & Fintech XRPL Hackathon (New York, Oct 24-25, 2026), Agentic Finance track.

**Status:** M0 (scaffold). See [`AGENTS.md`](./AGENTS.md) for the build brief, milestones and locked design, and [`DECISIONS.md`](./DECISIONS.md) for decisions.

## Develop

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm check   # lint, typecheck, build, test
```

Testnet only. Wallet seeds live in `.env` (gitignored); never commit or print them.

```bash
pnpm testnet:setup        # fund buyer, seller, arbiter and watcher wallets; writes .env
pnpm testnet:raw-escrow   # M1: prove create/finish/cancel and the three failure cases (~2 min)
```

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

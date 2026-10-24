# Pitch notes

Working notes for the Agentic Finance track demo. Not final copy.

## The problem in one line

An AI agent that pays per request with x402 today pays first and hopes. If the data is wrong, stale or garbage, the money is already gone, and an agent can't dispute a charge.

## The pain point, concretely

x402's live scheme on XRPL is `exact`. It settles the buyer's `Payment` as soon as the seller's handler returns a success, before the buyer can look at what it got. Three things go wrong for an agent:

1. **It pays for bad data.** On our testnet run, the cheating seller answered a paid XRP quote request with `{"symbol":"XRP","price":-1,"asOf":"2019-01-01T00:00:00Z"}`. That is a 200 response, so under `exact` it settles: the agent is down 1.000012 XRP with nothing usable, permanently.
2. **x402 checks the payment, not the data.** The facilitator verifies the signature and the amount. Nothing in the protocol looks at what was delivered.
3. **It has no recourse.** `exact` has no refund operation, an agent can't file a chargeback, and there's no human in the loop to dispute it.

Same request with `auth-capture` on XRPL: the arbiter returned FAIL ("price -1 is not a positive number"), the escrow was never released, and after the deadline it was cancelled back to the agent. The agent lost 12 drops (0.000012 XRP), the network fee, and the seller got nothing. The demo page shows this side by side, with the EscrowCancel explorer link as proof.

## What we built

Verify-then-pay for x402 on the XRP Ledger:
1. The agent's payment is locked in a native XRPL Escrow.
2. The seller delivers.
3. An independent arbiter checks the delivery and releases the money only if it passes.
4. If it fails, or nobody answers, the escrow returns to the agent after its deadline.

There's no smart contract. XRPL consensus enforces every guarantee:
- The money can only go to the seller, and only with the arbiter's secret.
- After the deadline, it can only go back to the buyer.

It is a binding of x402's official `auth-capture` scheme, not a new protocol: the spec answers all 8 network requirements of the scheme's appendix. Sellers add one scheme to their existing `@x402/express` middleware, and buyers register one scheme in `@x402/fetch`.

## Demo script (about 2 minutes)

1. Open the demo page: buyer and seller balances, two buttons.
2. **Honest seller.** The timeline fills in, each step with an explorer link:
   - 402 issued
   - escrow locked
   - signed quote delivered
   - arbiter PASS
   - EscrowFinish

   The seller's balance goes up by exactly 1 XRP.
3. **Cheating seller.** It returns a bad price, still signed. The arbiter says FAIL with the reason. The escrow stays locked; after the deadline the watcher cancels it, and the buyer is back to where it started minus a 12-drop network fee. The seller got nothing.
4. Optional: `pnpm agent cheat`. Claude buys the quote, reads the verdict, and says the data was rejected and its money is coming back.

## Why it holds up

- **The facilitator can't steal or redirect.** It holds no keys and no funds. It relays the buyer's presigned escrow and nothing else.
- **The arbiter can't steal either.** Its only choices are "pay the seller the agreed amount" or "do nothing and it refunds".
- **The buyer can't fake a bad delivery.** The seller signs what it sends, and the arbiter checks that signature.
- **The seller can't get paid twice for one escrow.** Consensus consumes it once, and the facilitator deduplicates concurrent settles.
- **The buyer picks who judges.** The client refuses unknown arbiters and too-long locks before signing anything.

## Honest limitations

- A rejected payment refunds at the deadline, not instantly. XRPL can't cancel an escrow early.
- Full capture only: no partial capture or tips. Payment Channels are the v1 path for that.
- XRP only for now. TokenEscrow would extend it to RLUSD.

## Misa

The arbiter is pluggable. Anything that speaks the four-endpoint Arbiter HTTP API can judge. Misa is the first real arbiter, and its pitch doesn't depend on XRPL: the value is the independent check on data an agent buys, whichever chain settles the money. XRPL is the rail where that check can be enforced with no contract at all.

## Numbers from testnet (2026-10-24)

- Honest: seller +1,000,000 drops; buyer −1,000,012 drops (price + 12-drop fee).
- Cheat: buyer −12 drops after the refund; seller +0.
- See the M6 and M8 PRs for the explorer links.

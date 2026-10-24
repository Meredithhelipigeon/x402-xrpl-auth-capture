import Anthropic from "@anthropic-ai/sdk";
import { buyQuote, loadEnv, txLink, type BuyResult } from "@demo/common";

/**
 * Buyer agent (AGENTS.md section 7.4): Claude with one tool, buy_quote(symbol). The tool pays
 * by escrow through x402, forwards the signed quote to the arbiter, and returns the verdict.
 *
 *   pnpm agent [honest|cheat] ["what is XRP trading at?"]
 *
 * The scenario picks the seller's behaviour; the agent is not told which one it gets.
 * Spend is capped per run in code, not by the prompt.
 */

loadEnv();
const MODEL = "claude-opus-5-5";
const PRICE_CAP_DROPS = "2000000"; // per payment, enforced by the x402 client
const MAX_PURCHASES = 2; // per run

const mode = process.argv[2] === "cheat" ? "cheat" : "honest";
const task = process.argv[3] ?? "What is XRP trading at right now? Buy one quote and tell me what happened to my payment.";

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "buy_quote",
    description:
      "Buy one price quote for a symbol from the paid quote API. Costs up to 1 XRP, which is locked in an XRPL escrow. " +
      "An independent arbiter checks the quote: if it passes, the seller is paid; if it fails, nobody is paid and the " +
      "escrow returns to you after its deadline (about 2-3 minutes). Returns the quote, the arbiter's verdict, and explorer links.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker, e.g. XRP or BTC" } },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
];

let purchases = 0;

function describe(r: BuyResult): string {
  const lines = [`HTTP ${r.status}. Quote body: ${r.body}`];
  if (r.escrowTx) lines.push(`Escrow locked: ${txLink(r.escrowTx)}`);
  if (!r.receipt) return lines.concat("No arbiter receipt.").join("\n");
  lines.push(`Arbiter verdict: ${r.receipt.verdict}${r.receipt.reason ? ` (${r.receipt.reason})` : ""}`);
  lines.push(`Receipt signature valid and from the trusted arbiter: ${r.receiptValid}`);
  if (r.receipt.finishTxHash) lines.push(`Seller paid: ${txLink(r.receipt.finishTxHash)}`);
  else lines.push("Seller not paid. The escrow refunds to you automatically after its deadline.");
  return lines.join("\n");
}

async function runTool(block: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const input = block.input as { symbol?: unknown };
  if (block.name !== "buy_quote" || typeof input.symbol !== "string" || !/^[A-Za-z]{2,10}$/.test(input.symbol)) {
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: "Invalid tool call: buy_quote needs a ticker symbol." };
  }
  if (purchases >= MAX_PURCHASES) {
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: `Spend cap reached: at most ${MAX_PURCHASES} purchases per run.` };
  }
  purchases++;
  console.log(`\n[tool] buy_quote(${input.symbol}) against the ${mode} seller...`);
  try {
    const result = await buyQuote({ symbol: input.symbol.toUpperCase(), mode, maxDropsPerPayment: PRICE_CAP_DROPS });
    const text = describe(result);
    console.log(text.replace(/^/gm, "[tool] "));
    return { type: "tool_result", tool_use_id: block.id, content: text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[tool] failed: ${message}`);
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: `Purchase failed: ${message}` };
  }
}

async function main(): Promise<void> {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: task }];
  console.log(`[user] ${task}`);

  for (let turn = 0; turn < 8; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system:
        "You are a buyer agent with an XRP wallet. You buy data with the buy_quote tool. Payments are held in escrow and " +
        "only released to the seller if an independent arbiter accepts the data. Report the price only if the arbiter " +
        "passed it; otherwise say the data was rejected and that your money is being returned. Be brief.",
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      console.log(`[agent] declined (${response.stop_details?.category ?? "unknown"})`);
      process.exit(1);
    }
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      for (const b of response.content) if (b.type === "text") console.log(`\n[agent] ${b.text}`);
      process.exit(purchases > 0 ? 0 : 1);
    }
    messages.push({ role: "user", content: await Promise.all(toolUses.map(runTool)) });
  }
  console.log("[agent] stopped: too many turns");
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof Anthropic.AuthenticationError) console.error("No valid Anthropic credentials: set ANTHROPIC_API_KEY or run `ant auth login`.");
  else console.error(err);
  process.exit(1);
});

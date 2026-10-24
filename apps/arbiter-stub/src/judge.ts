/**
 * The demo judging rule (AGENTS.md section 7.2), kept in one function so Misa's real
 * verification can replace it. Input: the exact bytes the seller signed, and the order's terms.
 */

export interface QuoteTerms {
  kind: "quote";
  symbol: string;
  /** How old `asOf` may be when the arbiter judges it. */
  maxAgeSeconds: number;
}

export type Judgement = { verdict: "PASS" } | { verdict: "FAIL"; reason: string };

export function judge(body: string, terms: unknown, nowSeconds: number): Judgement {
  const t = terms as Partial<QuoteTerms> | undefined;
  if (t?.kind !== "quote" || typeof t.symbol !== "string") return { verdict: "FAIL", reason: "order has no judgeable terms" };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { verdict: "FAIL", reason: "body is not JSON" };
  }
  const q = data as { symbol?: unknown; price?: unknown; asOf?: unknown };
  if (q.symbol !== t.symbol) return { verdict: "FAIL", reason: `symbol is ${JSON.stringify(q.symbol)}, promised ${t.symbol}` };
  if (typeof q.price !== "number" || !Number.isFinite(q.price) || q.price <= 0) {
    return { verdict: "FAIL", reason: `price ${JSON.stringify(q.price)} is not a positive number` };
  }
  const asOf = typeof q.asOf === "string" ? Date.parse(q.asOf) / 1000 : typeof q.asOf === "number" ? q.asOf : NaN;
  if (!Number.isFinite(asOf)) return { verdict: "FAIL", reason: "asOf is missing or unreadable" };
  const age = nowSeconds - asOf;
  const maxAge = t.maxAgeSeconds ?? 60;
  if (age > maxAge) return { verdict: "FAIL", reason: `quote is ${Math.round(age)}s old, limit ${maxAge}s` };
  if (age < -30) return { verdict: "FAIL", reason: "asOf is in the future" };
  return { verdict: "PASS" };
}

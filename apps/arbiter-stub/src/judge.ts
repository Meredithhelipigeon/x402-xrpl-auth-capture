import { Ajv } from "ajv";
import addFormats from "ajv-formats";

/**
 * How the arbiter judges a delivery: against the order's terms, which are the seller's published
 * promise for the route (Misa's `AnswerPromise`, version 1: the response's JSON Schema). Misa runs
 * the checks when MISA_CHECKS_URL is set; otherwise a local stand-in runs the same three body checks,
 * so the demo works offline. Either way the arbiter keeps the preimage and decides the escrow.
 */

export interface AnswerPromise {
  version: 1;
  response_schema: Record<string, unknown> | null;
  max_latency_ms: number | null;
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export type Judgement =
  | { verdict: "PASS"; judge: JudgeName; checks: Check[] }
  | { verdict: "FAIL"; reason: string; judge: JudgeName; checks: Check[] };

export type JudgeName = "misa" | "local";

export type Judge = (body: string, terms: unknown) => Promise<Judgement>;

const MISA_TIMEOUT_MS = 10_000;

/** The judge for this process: Misa at MISA_CHECKS_URL, or the local stand-in. */
export function judgeFromEnv(): { judge: Judge; name: JudgeName; url?: string } {
  const url = process.env.MISA_CHECKS_URL?.trim();
  return url ? { judge: misaJudge(url), name: "misa", url } : { judge: localJudge, name: "local" };
}

/**
 * Misa's checks over HTTP (`POST /v1/checks`). The arbiter only has the body the seller signed, so it
 * reports the answer as a 200 JSON response with no timing; the terms carry no latency promise.
 * Anything but a verdict from Misa is a FAIL: the escrow then refunds, the safe side.
 */
export function misaJudge(baseUrl: string): Judge {
  const endpoint = new URL("/v1/checks", baseUrl).toString();
  return async (body, terms) => {
    const promise = readPromise(terms);
    if (!promise) return fail("misa", "order has no judgeable terms");
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          answer: { status: 200, content_type: "application/json", body, elapsed_ms: 0 },
          promise,
        }),
        signal: AbortSignal.timeout(MISA_TIMEOUT_MS),
      });
    } catch (error) {
      return fail("misa", `Misa could not be reached (${error instanceof Error ? error.name : "error"})`);
    }
    const verdict = readVerdict(await response.json().catch(() => null));
    if (!response.ok || !verdict) return fail("misa", `Misa did not return a verdict (HTTP ${response.status})`);
    return verdict.passed ? { verdict: "PASS", judge: "misa", checks: verdict.checks } : failed("misa", verdict.checks);
  };
}

/** The local stand-in: Misa's body checks (JSON, matches the schema, not empty), without Misa. */
export const localJudge: Judge = async (body, terms) => {
  const promise = readPromise(terms);
  if (!promise) return fail("local", "order has no judgeable terms");
  const checks: Check[] = [];
  let value: unknown;
  try {
    value = JSON.parse(body);
    checks.push({ name: "json_body", passed: true, detail: "Parsed as JSON" });
  } catch {
    checks.push({ name: "json_body", passed: false, detail: "Not JSON" });
    return failed("local", checks);
  }
  if (promise.response_schema === null) {
    checks.push({ name: "matches_schema", passed: true, detail: "The seller published no response schema" });
  } else {
    const ajv = new Ajv({ strict: false, allErrors: false });
    addFormats.default(ajv);
    let validate: ReturnType<Ajv["compile"]>;
    try {
      validate = ajv.compile(promise.response_schema);
    } catch {
      checks.push({ name: "matches_schema", passed: false, detail: "The seller's response schema is not valid JSON Schema" });
      return failed("local", checks);
    }
    const valid = validate(value);
    const error = validate.errors?.[0];
    const where = error?.instancePath ? error.instancePath : "answer";
    checks.push({
      name: "matches_schema",
      passed: valid,
      detail: valid ? "Valid" : `${where} ${error?.message ?? "is invalid"}`,
    });
  }
  const empty =
    value === null || value === "" || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
  checks.push({ name: "not_empty", passed: !empty, detail: empty ? "The answer is empty" : "Has content" });
  return checks.every((c) => c.passed) ? { verdict: "PASS", judge: "local", checks } : failed("local", checks);
};

function readPromise(terms: unknown): AnswerPromise | null {
  if (!isRecord(terms) || terms.version !== 1) return null;
  const schema = terms.response_schema;
  if (schema !== null && !isRecord(schema)) return null;
  return { version: 1, response_schema: schema, max_latency_ms: null };
}

function readVerdict(value: unknown): { passed: boolean; checks: Check[] } | null {
  if (!isRecord(value) || typeof value.passed !== "boolean" || !Array.isArray(value.checks)) return null;
  const checks = value.checks.filter(
    (c): c is Check => isRecord(c) && typeof c.name === "string" && typeof c.passed === "boolean" && typeof c.detail === "string",
  );
  return { passed: value.passed, checks };
}

/** A FAIL whose reason is the first check that didn't pass, e.g. "matches_schema: /price must be > 0". */
function failed(judge: JudgeName, checks: Check[]): Judgement {
  const first = checks.find((c) => !c.passed);
  return { verdict: "FAIL", reason: first ? `${first.name}: ${first.detail}` : "the answer did not pass", judge, checks };
}

function fail(judge: JudgeName, reason: string): Judgement {
  return { verdict: "FAIL", reason, judge, checks: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

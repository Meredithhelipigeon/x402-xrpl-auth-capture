import { Ajv } from "ajv";
import addFormats from "ajv-formats";

/**
 * How the arbiter judges a delivery. The order's terms name the seller's Misa listing and the action
 * bought (`{ slug, operation_id }`), never a schema: the promise is whatever the seller published.
 * Misa checks the body against that listing's frozen promise when MISA_CHECKS_URL is set; otherwise a
 * local stand-in reads the action's 200 schema from the seller's GET /openapi.json, as Misa does when
 * it lists an API, and runs the same three body checks, so the demo works offline. Either way the
 * arbiter keeps the preimage and decides the escrow.
 */

export interface ListedAction {
  slug: string;
  operation_id: string;
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

const TIMEOUT_MS = 10_000;

/** The judge for this process: Misa at MISA_CHECKS_URL, or the local stand-in reading the seller's OpenAPI. */
export function judgeFromEnv(sellerOpenApiUrl: string): { judge: Judge; name: JudgeName; url: string } {
  const url = process.env.MISA_CHECKS_URL?.trim();
  return url
    ? { judge: misaJudge(url), name: "misa", url }
    : { judge: localJudge(sellerOpenApiUrl), name: "local", url: sellerOpenApiUrl };
}

/**
 * Misa's checks over HTTP (`POST /x/{slug}/checks`). The arbiter only has the body the seller signed, so
 * it reports the answer as a 200 JSON response with no timing. Anything but a verdict from Misa is a
 * FAIL: the escrow then refunds, the safe side.
 */
export function misaJudge(baseUrl: string): Judge {
  return async (body, terms) => {
    const action = readAction(terms);
    if (!action) return fail("misa", "order has no judgeable terms");
    const endpoint = new URL(`/x/${encodeURIComponent(action.slug)}/checks`, baseUrl).toString();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          operation_id: action.operation_id,
          answer: { status: 200, content_type: "application/json", body, elapsed_ms: 0 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return fail("misa", `Misa could not be reached (${error instanceof Error ? error.name : "error"})`);
    }
    const json = await response.json().catch(() => null);
    const verdict = readVerdict(json);
    if (!response.ok || !verdict) {
      const reason = isRecord(json) && typeof json.reason === "string" ? `, ${json.reason}` : "";
      return fail("misa", `Misa did not return a verdict (HTTP ${response.status}${reason})`);
    }
    return verdict.passed ? { verdict: "PASS", judge: "misa", checks: verdict.checks } : failed("misa", verdict.checks);
  };
}

/** The local stand-in: Misa's body checks (JSON, matches the schema, not empty), without Misa. */
export function localJudge(sellerOpenApiUrl: string): Judge {
  return async (body, terms) => {
    const action = readAction(terms);
    if (!action) return fail("local", "order has no judgeable terms");
    const schema = await responseSchema(sellerOpenApiUrl, action.operation_id);
    if (typeof schema === "string") return fail("local", schema);

    const checks: Check[] = [];
    let value: unknown;
    try {
      value = JSON.parse(body);
      checks.push({ name: "json_body", passed: true, detail: "Parsed as JSON" });
    } catch {
      checks.push({ name: "json_body", passed: false, detail: "Not JSON" });
      return failed("local", checks);
    }
    if (schema === null) {
      checks.push({ name: "matches_schema", passed: true, detail: "The seller published no response schema" });
    } else {
      const ajv = new Ajv({ strict: false, allErrors: false });
      addFormats.default(ajv);
      let validate: ReturnType<Ajv["compile"]>;
      try {
        validate = ajv.compile(schema);
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
}

/** The action's 200 JSON schema from the seller's OpenAPI, null if it has none, or why it couldn't be read. */
async function responseSchema(openApiUrl: string, operationId: string): Promise<Record<string, unknown> | null | string> {
  let doc: unknown;
  try {
    const response = await fetch(openApiUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    doc = response.ok ? await response.json() : null;
  } catch {
    doc = null;
  }
  if (!isRecord(doc) || !isRecord(doc.paths)) return "the seller's OpenAPI could not be read";
  for (const item of Object.values(doc.paths)) {
    if (!isRecord(item)) continue;
    for (const operation of Object.values(item)) {
      if (!isRecord(operation) || operation.operationId !== operationId) continue;
      const schema = path(operation, ["responses", "200", "content", "application/json", "schema"]);
      return isRecord(schema) ? schema : null;
    }
  }
  return `the seller's OpenAPI has no action "${operationId}"`;
}

function path(value: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), value);
}

function readAction(terms: unknown): ListedAction | null {
  if (!isRecord(terms) || typeof terms.slug !== "string" || typeof terms.operation_id !== "string") return null;
  if (terms.slug === "" || terms.operation_id === "") return null;
  return { slug: terms.slug, operation_id: terms.operation_id };
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

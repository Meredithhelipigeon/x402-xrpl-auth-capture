import { createHash } from "node:crypto";
import { deriveAddress, sign, verify } from "ripple-keypairs";
import type { DeliveryKeys } from "./delivery.js";

/**
 * The arbiter: holds each order's preimage, judges the seller's delivery, and on PASS
 * submits EscrowFinish itself. The fulfillment never leaves it. This is the contract
 * Misa implements (AGENTS.md sections 5.3 and 7.2); `apps/arbiter-stub` is the demo one.
 */

export interface ArbiterOrder {
  orderId: string;
  condition: string;
  /** Unix seconds. */
  captureDeadline: number;
  /** Arbiter classic address. */
  captureAuthorizer: string;
  /** The key behind `captureAuthorizer`, so buyer and facilitator can check `orderSignature`. */
  captureAuthorizerPublicKey: string;
  /**
   * The arbiter's signature over the order terms (see `signOrder`). Proves the condition is the
   * arbiter's: without it a seller could name a trusted arbiter but lock the escrow with its own
   * preimage, then finish the escrow itself.
   */
  orderSignature: string;
}

export type ArbiterOrderStatus = "created" | "funded" | "passed" | "failed" | "finished" | "reclaimed";

export interface ArbiterOrderView extends ArbiterOrder {
  status: ArbiterOrderStatus | string;
  network?: string;
  payTo?: string;
  amount?: string;
  asset?: string;
  resource?: string;
  escrow?: { owner: string; offerSequence: number; txHash?: string };
}

export interface ArbiterReceipt {
  orderId: string;
  verdict: "PASS" | "FAIL";
  reason?: string;
  escrow?: { owner: string; offerSequence: number };
  /** Set when PASS and EscrowFinish validated. */
  finishTxHash?: string;
  deliveryHash?: string;
  /** Unix seconds. */
  issuedAt: number;
  /** Arbiter classic address. */
  signer: string;
  /**
   * The key behind `signer`, so anyone can check the receipt without a lookup.
   * Addition to AGENTS.md section 5.3 (an address alone cannot verify a signature).
   */
  signerPublicKey: string;
  /** Over sha256 of the canonical JSON of every other field. */
  signature: string;
}

export interface CreateOrderInput {
  network: string;
  payTo: string;
  amount: string;
  asset: string;
  resource: string;
  terms?: unknown;
}

export interface RecordFundingInput {
  orderId: string;
  owner: string;
  offerSequence: number;
  txHash: string;
}

export interface SubmitDeliveryInput {
  orderId: string;
  body: string;
  sellerSignature: string;
  /** Addition to AGENTS.md section 5.3, for the same reason as `signerPublicKey`. */
  sellerPublicKey: string;
  submittedBy: "buyer" | "seller";
}

export interface Arbiter {
  createOrder(i: CreateOrderInput): Promise<ArbiterOrder>;
  getOrder(orderId: string): Promise<ArbiterOrderView | undefined>;
  recordFunding(i: RecordFundingInput): Promise<void>;
  submitDelivery(i: SubmitDeliveryInput): Promise<ArbiterReceipt>;
}

export class ArbiterHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`arbiter returned HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

/** `Arbiter` over the HTTP API in AGENTS.md section 7.2. */
export class HttpArbiterClient implements Arbiter {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async createOrder(i: CreateOrderInput): Promise<ArbiterOrder> {
    return (await this.call("POST", "/orders", i)) as ArbiterOrder;
  }

  async getOrder(orderId: string): Promise<ArbiterOrderView | undefined> {
    try {
      return (await this.call("GET", `/orders/${encodeURIComponent(orderId)}`)) as ArbiterOrderView;
    } catch (err) {
      if (err instanceof ArbiterHttpError && err.status === 404) return undefined;
      throw err;
    }
  }

  async recordFunding({ orderId, ...rest }: RecordFundingInput): Promise<void> {
    await this.call("POST", `/orders/${encodeURIComponent(orderId)}/funding`, rest);
  }

  async submitDelivery({ orderId, ...rest }: SubmitDeliveryInput): Promise<ArbiterReceipt> {
    return (await this.call("POST", `/orders/${encodeURIComponent(orderId)}/delivery`, rest)) as ArbiterReceipt;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // keep the raw text
    }
    if (!res.ok) throw new ArbiterHttpError(res.status, parsed);
    return parsed;
  }
}

/** JSON with keys sorted at every level and undefined fields dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** What an order signature covers: everything the buyer's EscrowCreate commits to, plus the order's identity. */
export interface OrderTerms {
  network: string;
  orderId: string;
  condition: string;
  captureDeadline: number;
  captureAuthorizer: string;
  payTo: string;
  amount: string;
  asset: string;
}

/** Keeps an order signature from being mistaken for any other message the arbiter's key signs. */
export const ORDER_SIGNATURE_DOMAIN = "x402-auth-capture-xrpl-order-v1";

/** sha256 of the canonical JSON of the terms plus the domain tag, condition uppercased. Uppercase hex. */
export function orderDigest(terms: OrderTerms): string {
  const message = canonicalJson({ ...terms, condition: terms.condition.toUpperCase(), domain: ORDER_SIGNATURE_DOMAIN });
  return createHash("sha256").update(message, "utf8").digest("hex").toUpperCase();
}

export function signOrder(
  keys: DeliveryKeys,
  terms: Omit<OrderTerms, "captureAuthorizer">,
): Pick<ArbiterOrder, "captureAuthorizer" | "captureAuthorizerPublicKey" | "orderSignature"> {
  const captureAuthorizer = deriveAddress(keys.publicKey);
  return {
    captureAuthorizer,
    captureAuthorizerPublicKey: keys.publicKey,
    orderSignature: sign(orderDigest({ ...terms, captureAuthorizer }), keys.privateKey),
  };
}

/** True when `signature` is `terms.captureAuthorizer`'s signature over `terms`, made with `publicKey`. */
export function verifyOrderSignature(terms: OrderTerms, publicKey: unknown, signature: unknown): boolean {
  if (typeof publicKey !== "string" || typeof signature !== "string") return false;
  try {
    return deriveAddress(publicKey) === terms.captureAuthorizer && verify(orderDigest(terms), signature, publicKey);
  } catch {
    return false;
  }
}

export type UnsignedReceipt = Omit<ArbiterReceipt, "signer" | "signerPublicKey" | "signature">;

function receiptDigest(fields: Omit<ArbiterReceipt, "signature">): string {
  return createHash("sha256").update(canonicalJson(fields), "utf8").digest("hex").toUpperCase();
}

export function signReceipt(keys: DeliveryKeys, receipt: UnsignedReceipt): ArbiterReceipt {
  const fields = { ...receipt, signer: deriveAddress(keys.publicKey), signerPublicKey: keys.publicKey };
  return { ...fields, signature: sign(receiptDigest(fields), keys.privateKey) };
}

export type ReceiptCheck = { ok: true } | { ok: false; reason: "malformed" | "signer_mismatch" | "untrusted_signer" | "bad_signature" };

/**
 * Checks that `receipt` was signed by the key behind `receipt.signer`. Pass `trustedArbiters`
 * to also require that signer be one the caller trusts.
 */
export function verifyReceipt(receipt: ArbiterReceipt, trustedArbiters?: readonly string[]): ReceiptCheck {
  const { signature, ...fields } = receipt;
  let derived: string;
  try {
    derived = deriveAddress(receipt.signerPublicKey);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (derived !== receipt.signer) return { ok: false, reason: "signer_mismatch" };
  if (trustedArbiters && !trustedArbiters.includes(receipt.signer)) return { ok: false, reason: "untrusted_signer" };
  try {
    return verify(receiptDigest(fields), signature, receipt.signerPublicKey) ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

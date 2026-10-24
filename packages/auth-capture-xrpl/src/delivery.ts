import { createHash } from "node:crypto";
import { deriveAddress, sign, verify } from "ripple-keypairs";

/**
 * Seller-signed deliveries.
 *
 * The seller signs sha256(orderId + "\n" + body) with the key of its `payTo` account and returns
 * the signature and public key in response headers. The arbiter checks that the key derives to
 * `payTo` and that the signature covers the exact bytes, so the buyer cannot forge a bad delivery
 * and the arbiter judges exactly what the buyer received.
 *
 * Limitation: the public key must be the account's master key. An account that signs with a
 * regular key would derive a different address. Fine for the demo; noted in DECISIONS.md.
 */

export const DELIVERY_SIGNATURE_HEADER = "X-DELIVERY-SIGNATURE";
export const DELIVERY_PUBLIC_KEY_HEADER = "X-DELIVERY-PUBLIC-KEY";

/** Uppercase hex SHA-256 of `orderId + "\n" + body` (UTF-8). */
export function deliveryHash(orderId: string, body: string): string {
  if (orderId.length === 0 || orderId.includes("\n")) {
    throw new TypeError("orderId must be non-empty and must not contain a newline");
  }
  return createHash("sha256").update(`${orderId}\n${body}`, "utf8").digest("hex").toUpperCase();
}

/** Anything with an XRPL keypair, such as an xrpl.js `Wallet`. */
export interface DeliveryKeys {
  publicKey: string;
  privateKey: string;
}

export interface SignedDelivery {
  deliveryHash: string;
  signature: string;
  publicKey: string;
}

export function signDelivery(keys: DeliveryKeys, orderId: string, body: string): SignedDelivery {
  const hash = deliveryHash(orderId, body);
  return { deliveryHash: hash, signature: sign(hash, keys.privateKey), publicKey: keys.publicKey };
}

export type DeliveryCheck =
  | { ok: true; deliveryHash: string }
  | { ok: false; reason: "malformed" | "signer_not_pay_to" | "bad_signature" };

export function verifyDelivery(input: {
  orderId: string;
  body: string;
  signature: string;
  publicKey: string;
  payTo: string;
}): DeliveryCheck {
  let hash: string;
  let signer: string;
  try {
    hash = deliveryHash(input.orderId, input.body);
    signer = deriveAddress(input.publicKey);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (signer !== input.payTo) return { ok: false, reason: "signer_not_pay_to" };
  return safeVerify(hash, input.signature, input.publicKey)
    ? { ok: true, deliveryHash: hash }
    : { ok: false, reason: "bad_signature" };
}

function safeVerify(messageHex: string, signature: string, publicKey: string): boolean {
  try {
    return verify(messageHex, signature, publicKey);
  } catch {
    return false;
  }
}

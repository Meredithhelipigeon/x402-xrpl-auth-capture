import { createHash, randomBytes } from "node:crypto";

/**
 * PREIMAGE-SHA-256 crypto-conditions (RFC draft "crypto-conditions", type 0),
 * DER-encoded the way XRPL Escrow expects them.
 *
 *   condition   = A0 25 80 20 <SHA256(preimage), 32 bytes> 81 01 20
 *   fulfillment = A0 22 80 20 <preimage, 32 bytes>
 *
 * The trailing `81 01 20` is the cost field: the preimage length, 32.
 * Byte-for-byte equality with five-bells-condition is checked in the tests.
 */

export const PREIMAGE_LENGTH = 32;

const CONDITION_PREFIX = "A0258020";
const CONDITION_SUFFIX = "810120";
const FULFILLMENT_PREFIX = "A0228020";
const CONDITION_PATTERN = /^A0258020[0-9A-F]{64}810120$/;

/** A fresh 32-byte preimage from the OS CSPRNG. Never reuse one across orders. */
export function newPreimage(): Uint8Array {
  return new Uint8Array(randomBytes(PREIMAGE_LENGTH));
}

/** Uppercase hex condition for `EscrowCreate.Condition` and `extra.condition`. */
export function conditionFromPreimage(preimage: Uint8Array): string {
  assertPreimage(preimage);
  const digest = createHash("sha256").update(preimage).digest("hex").toUpperCase();
  return CONDITION_PREFIX + digest + CONDITION_SUFFIX;
}

/** Uppercase hex fulfillment for `EscrowFinish.Fulfillment`. Only the arbiter ever holds this. */
export function fulfillmentFromPreimage(preimage: Uint8Array): string {
  assertPreimage(preimage);
  return FULFILLMENT_PREFIX + Buffer.from(preimage).toString("hex").toUpperCase();
}

/** True for a 78-hex-character PREIMAGE-SHA-256 condition with a 32-byte cost. Case-insensitive. */
export function isWellFormedCondition(condition: string): boolean {
  return CONDITION_PATTERN.test(condition.toUpperCase());
}

function assertPreimage(preimage: Uint8Array): void {
  if (!(preimage instanceof Uint8Array) || preimage.length !== PREIMAGE_LENGTH) {
    throw new TypeError(`preimage must be ${PREIMAGE_LENGTH} bytes`);
  }
}

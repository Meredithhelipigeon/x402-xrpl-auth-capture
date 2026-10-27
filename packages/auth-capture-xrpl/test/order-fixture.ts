import type { PaymentRequirements } from "@x402/core/types";
import { signOrder } from "../src/arbiter.js";
import type { DeliveryKeys } from "../src/delivery.js";

/** Sets `keys`' order signature over `req`, replacing any it had and keeping the `captureAuthorizer` it names. */
export function withOrderSignature(req: PaymentRequirements, keys: DeliveryKeys): PaymentRequirements {
  const e = req.extra as Record<string, unknown>;
  const { captureAuthorizerPublicKey, orderSignature } = signOrder(keys, {
    network: req.network,
    orderId: String(e.orderId),
    condition: String(e.condition),
    captureDeadline: Number(e.captureDeadline),
    payTo: req.payTo,
    amount: req.amount,
    asset: req.asset,
  });
  return { ...req, extra: { ...e, captureAuthorizerPublicKey, orderSignature } };
}

/** `req` with the order signature removed. */
export function withoutOrderSignature(req: PaymentRequirements): PaymentRequirements {
  const { captureAuthorizerPublicKey: _k, orderSignature: _s, ...extra } = req.extra as Record<string, unknown>;
  return { ...req, extra };
}

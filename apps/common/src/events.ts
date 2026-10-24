import { URLS } from "./env.js";

/** One step on the demo timeline (AGENTS.md section 7.5). */
export type DemoEventType =
  | "payment_required"
  | "escrow_locked"
  | "delivered"
  | "verdict"
  | "escrow_finished"
  | "escrow_reclaimed"
  | "error";

export interface DemoEvent {
  type: DemoEventType;
  source: "facilitator" | "arbiter" | "seller" | "buyer" | "e2e";
  orderId?: string;
  txHash?: string;
  detail?: Record<string, unknown>;
  at?: number;
}

/**
 * Fire-and-forget POST to the demo server (section 7.6). The demo is optional, so a
 * missing or slow demo server never breaks a payment.
 */
export function emit(event: DemoEvent): void {
  if (process.env.DEMO_EVENTS === "off") return;
  const body = JSON.stringify({ ...event, at: event.at ?? Date.now() });
  void fetch(`${URLS.demo}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(1_000),
  }).catch(() => {});
}

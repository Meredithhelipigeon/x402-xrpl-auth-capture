import { decodePaymentSignatureHeader } from "@x402/core/http";
import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
  SettleResponse,
  SupportedKind,
} from "@x402/core/types";
import { decode } from "xrpl";
import type { Arbiter, ArbiterOrder, ArbiterOrderView } from "../arbiter.js";
import {
  ASSET_XRP,
  CAPTURE_MODE,
  DYNAMIC_EXTRA_FIELDS,
  ERRORS,
  OPERATOR_TYPE,
  PAYMENT_FLOW,
  SCHEME,
  isXrplNetwork,
} from "../types.js";

export interface AuthCaptureXrplServerOptions {
  arbiter: Arbiter;
  /** The arbiter's classic address, advertised as `extra.captureAuthorizer`. */
  captureAuthorizer: string;
  /** Order terms the arbiter judges against, per 402 (e.g. the seller's published response schema). */
  terms?: (requirements: PaymentRequirements, resourceUrl: string) => unknown;
  /** Called when the arbiter can't be told about a funded escrow. Default logs. */
  onFundingError?: (err: unknown, orderId: string) => void;
}

const FLOWS: PaymentFlowConfig = { supported: ["escrow"], default: "escrow" };

/**
 * Seller side of `auth-capture` on XRPL.
 *
 * Every 402 carries a fresh arbiter order (orderId, condition, deadline). @x402/core 2.28 builds
 * the 402 on every request, the paid retry included, and matches `accepted` with those dynamic
 * fields left out. So on a paid retry this scheme reloads the buyer's order from the arbiter
 * instead of creating a new one, and the matched requirements carry the order the buyer signed for.
 *
 * Capture is deferred: the before-handler settle locks the escrow, the after-handler settle is
 * skipped, and the arbiter captures later. A failed handler settles nothing; the escrow refunds.
 */
export class AuthCaptureXrplServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = "sequence";
  readonly paymentFlows = { sequence: FLOWS, ticketSequence: FLOWS };
  readonly dynamicExtraFields = [...DYNAMIC_EXTRA_FIELDS];
  readonly schemeHooks: SchemeServerHooks;
  /** Collect results by orderId, so the skipped after-handler settle can echo the escrow's tx hash. */
  private readonly collected = new Map<string, SettleResponse>();
  /** Orders with a collect in progress, mapped to the signed blob of the request that claimed them. */
  private readonly inFlight = new Map<string, string>();

  constructor(private readonly opts: AuthCaptureXrplServerOptions) {
    this.schemeHooks = {
      onBeforeSettle: async (ctx) => {
        if (ctx.phase === "after-handler") {
          // Deferred capture: nothing moves after the handler. PAYMENT-RESPONSE echoes this
          // result, so hand back the collect (the EscrowCreate hash) rather than an empty one.
          const orderId = String(ctx.paymentPayload.accepted.extra.orderId);
          const collect = this.collected.get(orderId);
          this.collected.delete(orderId);
          return {
            skip: true,
            result: collect ?? { success: true, transaction: "", network: ctx.requirements.network },
          };
        }
        if (ctx.phase !== "before-handler") return;
        const extra = ctx.paymentPayload.accepted.extra as Record<string, unknown>;
        const orderId = typeof extra.orderId === "string" ? extra.orderId : undefined;
        // One collect per order: until the arbiter records funding the order still reads "created",
        // so a second escrow for it would otherwise also pass and get the resource a second time.
        if (!orderId || this.inFlight.has(orderId)) return { abort: true, reason: ERRORS.order };
        this.inFlight.set(orderId, blobOf(ctx));
        const order = await this.opts.arbiter.getOrder(orderId);
        if (!order || order.status !== "created" || !orderMatches(order, ctx.requirements as PaymentRequirements, extra)) {
          this.release(orderId, blobOf(ctx));
          return { abort: true, reason: ERRORS.order };
        }
      },
      onAfterSettle: async (ctx) => {
        if (ctx.phase !== "before-handler" || !ctx.result.success) return;
        const orderId = String(ctx.paymentPayload.accepted.extra.orderId);
        this.collected.set(orderId, { ...(ctx.result as SettleResponse) });
        try {
          const tx = decode(blobOf(ctx)) as { Account: string; Sequence: number; TicketSequence?: number };
          const offerSequence = tx.Sequence === 0 && tx.TicketSequence ? tx.TicketSequence : tx.Sequence;
          await this.opts.arbiter.recordFunding({ orderId, owner: tx.Account, offerSequence, txHash: ctx.result.transaction });
          // The arbiter now reports the order as funded, which refuses any later collect.
          this.release(orderId, blobOf(ctx));
        } catch (err) {
          // Keep the claim: the order still reads "created" at the arbiter.
          (this.opts.onFundingError ?? defaultFundingError)(err, orderId);
        }
      },
      onSettleFailure: async (ctx) => {
        // Fires for our own abort too, so only the request that holds the claim releases it.
        if (ctx.phase === "before-handler") this.release(String(ctx.paymentPayload.accepted.extra.orderId), blobOf(ctx));
      },
      onVerifiedPaymentCanceled: async (ctx) => {
        // The handler failed after the collect; no after-handler settle will read the stored result.
        this.collected.delete(String(ctx.paymentPayload.accepted.extra.orderId));
      },
    };
  }

  /** Releases an order's collect claim, only if `blob` is the request that took it. */
  private release(orderId: string, blob: string): void {
    if (this.inFlight.get(orderId) === blob) this.inFlight.delete(orderId);
  }

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object") {
      if (price.asset !== ASSET_XRP) throw new Error(`Only XRP is supported, got ${price.asset}`);
      return { asset: ASSET_XRP, amount: drops(price.amount) };
    }
    if (typeof price === "string" && price.trim().startsWith("$")) {
      throw new Error("Dollar prices are not supported: there is no USD/XRP rate in v0. Price in drops.");
    }
    return { asset: ASSET_XRP, amount: drops(String(price)) };
  }

  getAssetDecimals(_asset: string, _network: Network): number {
    return 6;
  }

  async enhancePaymentRequirements(req: PaymentRequirements, _kind: SupportedKind, _exts: string[]): Promise<PaymentRequirements> {
    return {
      ...req,
      extra: {
        ...req.extra,
        paymentFlow: PAYMENT_FLOW,
        areFeesSponsored: false,
        operatorType: OPERATOR_TYPE,
        captureAuthorizer: this.opts.captureAuthorizer,
        captureMode: CAPTURE_MODE,
      },
    };
  }

  /** Adds orderId, condition and captureDeadline to each of this scheme's accepts that lacks them. */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<PaymentRequirements[]> => {
    const paidOrderId = paidRetryOrderId(ctx);
    return Promise.all(
      ctx.requirements.map(async (req) => {
        if (req.scheme !== SCHEME || !isXrplNetwork(req.network) || req.extra.orderId !== undefined) return req;
        const order = (paidOrderId && (await this.reusableOrder(paidOrderId, req))) || (await this.createOrder(req, ctx.resourceInfo.url));
        return {
          ...req,
          extra: { ...req.extra, orderId: order.orderId, condition: order.condition, captureDeadline: order.captureDeadline },
        };
      }),
    );
  };

  /** No settle on cancel: the escrow stays locked, the arbiter never finishes it, and it refunds at the deadline. */
  settleOnCancel(): void {}

  validateFacilitatorSupport(network: Network, kind: SupportedKind, _exts: string[]): string | void {
    if (!isXrplNetwork(network)) return `Network ${network} is not an XRPL network`;
    if (kind.scheme !== SCHEME) return `Facilitator scheme ${kind.scheme} is not "${SCHEME}"`;
    const operatorTypes = kind.extra?.operatorTypes;
    if (!Array.isArray(operatorTypes) || !operatorTypes.includes(OPERATOR_TYPE)) {
      return `Facilitator does not support operatorType "${OPERATOR_TYPE}" on ${network}`;
    }
  }

  private async createOrder(req: PaymentRequirements, resource: string): Promise<ArbiterOrder> {
    const order = await this.opts.arbiter.createOrder({
      network: req.network,
      payTo: req.payTo,
      amount: req.amount,
      asset: req.asset,
      resource,
      terms: this.opts.terms?.(req, resource),
    });
    if (order.captureAuthorizer !== this.opts.captureAuthorizer) {
      throw new Error(`Arbiter returned captureAuthorizer ${order.captureAuthorizer}, expected ${this.opts.captureAuthorizer}`);
    }
    return order;
  }

  /** The buyer's order, if it is still unfunded and is for these exact terms. */
  private async reusableOrder(orderId: string, req: PaymentRequirements): Promise<ArbiterOrderView | undefined> {
    const order = await this.opts.arbiter.getOrder(orderId);
    if (!order || order.status !== "created" || order.captureAuthorizer !== this.opts.captureAuthorizer) return undefined;
    if (order.payTo !== undefined && order.payTo !== req.payTo) return undefined;
    if (order.amount !== undefined && order.amount !== req.amount) return undefined;
    if (order.network !== undefined && order.network !== req.network) return undefined;
    return order;
  }
}

function orderMatches(order: ArbiterOrderView, req: PaymentRequirements, accepted: Record<string, unknown>): boolean {
  return (
    typeof accepted.condition === "string" &&
    accepted.condition.toUpperCase() === order.condition.toUpperCase() &&
    accepted.captureDeadline === order.captureDeadline &&
    req.extra.orderId === order.orderId &&
    (order.payTo === undefined || order.payTo === req.payTo) &&
    (order.amount === undefined || order.amount === req.amount)
  );
}

/** orderId from the PAYMENT-SIGNATURE header of the request being priced, if any. */
function paidRetryOrderId(ctx: SchemePaymentRequiredContext): string | undefined {
  const fromPayload = ctx.paymentPayload?.accepted?.extra?.orderId;
  if (typeof fromPayload === "string") return fromPayload;
  const adapter = (ctx.transportContext as { request?: { adapter?: { getHeader(name: string): string | undefined } } } | undefined)
    ?.request?.adapter;
  const header = adapter?.getHeader("payment-signature") ?? adapter?.getHeader("PAYMENT-SIGNATURE");
  if (!header) return undefined;
  try {
    const orderId = decodePaymentSignatureHeader(header).accepted?.extra?.orderId;
    return typeof orderId === "string" ? orderId : undefined;
  } catch {
    return undefined;
  }
}

function blobOf(ctx: { paymentPayload: { payload: unknown } }): string {
  return String((ctx.paymentPayload.payload as { signedTxBlob?: unknown } | undefined)?.signedTxBlob);
}

function drops(amount: string): string {
  if (!/^[1-9]\d*$/.test(amount)) throw new Error(`XRP price must be a positive whole number of drops, got ${amount}`);
  return amount;
}

function defaultFundingError(err: unknown, orderId: string): void {
  console.error(`[auth-capture-xrpl] could not record funding for order ${orderId}:`, err);
}

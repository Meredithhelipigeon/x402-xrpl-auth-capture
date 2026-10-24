/** The x402 scheme this package binds to the XRP Ledger. */
export const SCHEME = "auth-capture" as const;

/** CAIP-2 identifiers this binding accepts. Only testnet is used until Meredith approves mainnet. */
export const XRPL_NETWORKS = {
  mainnet: "xrpl:0",
  testnet: "xrpl:1",
} as const;

export { RIPPLE_EPOCH_OFFSET, toRippleTime, fromRippleTime } from "./time.js";
export {
  PREIMAGE_LENGTH,
  newPreimage,
  conditionFromPreimage,
  fulfillmentFromPreimage,
  isWellFormedCondition,
} from "./condition.js";

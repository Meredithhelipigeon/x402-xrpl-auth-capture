/**
 * Seconds between the Unix epoch (1970-01-01) and the Ripple epoch (2000-01-01).
 * XRPL time fields such as `CancelAfter` count seconds since the Ripple epoch.
 */
export const RIPPLE_EPOCH_OFFSET = 946_684_800;

/** Year 2286 in Unix seconds. Anything larger is almost certainly a millisecond value. */
const MAX_PLAUSIBLE_UNIX_SECONDS = 10_000_000_000;

/**
 * Converts Unix seconds to Ripple seconds.
 *
 * Note: xrpl.js `unixTimeToRippleTime` takes milliseconds. This helper takes seconds,
 * because x402 deadlines (`captureDeadline`) are Unix seconds.
 */
export function toRippleTime(unixSeconds: number): number {
  assertWholeSeconds(unixSeconds, "unixSeconds");
  if (unixSeconds >= MAX_PLAUSIBLE_UNIX_SECONDS) {
    throw new RangeError(`unixSeconds ${unixSeconds} looks like milliseconds; pass seconds`);
  }
  const ripple = unixSeconds - RIPPLE_EPOCH_OFFSET;
  if (ripple < 0) {
    throw new RangeError(`unixSeconds ${unixSeconds} is before the Ripple epoch`);
  }
  return ripple;
}

/** Converts Ripple seconds to Unix seconds. */
export function fromRippleTime(rippleSeconds: number): number {
  assertWholeSeconds(rippleSeconds, "rippleSeconds");
  if (rippleSeconds < 0) {
    throw new RangeError(`rippleSeconds ${rippleSeconds} is negative`);
  }
  return rippleSeconds + RIPPLE_EPOCH_OFFSET;
}

function assertWholeSeconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a whole number of seconds, got ${value}`);
  }
}

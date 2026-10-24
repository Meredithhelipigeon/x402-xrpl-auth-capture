import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { ReclaimWatcher, type ReclaimClient, type WatchedEscrow } from "../src/lifecycle/reclaim-watcher.js";

const watcherWallet = Wallet.generate();
const escrow: WatchedEscrow = { owner: Wallet.generate().classicAddress, offerSequence: 7, cancelAfter: 1_000, orderId: "ord_1" };

/** A fake ledger: escrows exist until cancelled; cancels succeed only past CancelAfter. */
function fakeClient(opts: { closeTime: { value: number }; exists?: boolean; cancelResult?: string }) {
  const state = { exists: opts.exists ?? true, submitted: [] as unknown[] };
  const client = {
    request: async (req: { command: string }) => {
      if (req.command === "ledger_entry") {
        if (state.exists) return { result: {} };
        throw Object.assign(new Error("entryNotFound"), { data: { error: "entryNotFound" } });
      }
      throw new Error(`unexpected request ${req.command}`);
    },
    submitAndWait: async (tx: unknown) => {
      state.submitted.push(tx);
      const result = opts.cancelResult ?? (opts.closeTime.value > escrow.cancelAfter ? "tesSUCCESS" : "tecNO_PERMISSION");
      if (result === "tesSUCCESS") state.exists = false;
      return { result: { hash: "ABC123", meta: { TransactionResult: result } } };
    },
  } as unknown as ReclaimClient;
  return { client, state };
}

function watcherWith(closeTime: { value: number }, client: ReclaimClient) {
  return new ReclaimWatcher({ client, wallet: watcherWallet, marginSeconds: 20, closeTime: async () => closeTime.value });
}

describe("ReclaimWatcher", () => {
  it("waits until CancelAfter plus the margin has passed", async () => {
    const t = { value: 1_010 };
    const { client, state } = fakeClient({ closeTime: t });
    const w = watcherWith(t, client);
    w.track(escrow);
    await w.tick();
    t.value = 1_020; // exactly at the margin: still too early
    await w.tick();
    expect(state.submitted).toHaveLength(0);
    expect(w.pending()).toHaveLength(1);
  });

  it("cancels an expired escrow and stops tracking it", async () => {
    const t = { value: 1_021 };
    const { client, state } = fakeClient({ closeTime: t });
    const w = watcherWith(t, client);
    const reclaimed: string[] = [];
    w.on("reclaimed", (e) => reclaimed.push(e.txHash));
    w.track(escrow);
    await w.tick();
    expect(state.submitted).toEqual([
      { TransactionType: "EscrowCancel", Account: watcherWallet.classicAddress, Owner: escrow.owner, OfferSequence: 7 },
    ]);
    expect(reclaimed).toEqual(["ABC123"]);
    expect(w.pending()).toHaveLength(0);
  });

  it("does not submit when someone already finished or cancelled it", async () => {
    const t = { value: 2_000 };
    const { client, state } = fakeClient({ closeTime: t, exists: false });
    const w = watcherWith(t, client);
    const closed: number[] = [];
    w.on("closed", (e) => closed.push(e.offerSequence));
    w.track(escrow);
    await w.tick();
    expect(state.submitted).toHaveLength(0);
    expect(closed).toEqual([7]);
    expect(w.pending()).toHaveLength(0);
  });

  it("keeps the escrow and reports when the ledger refuses the cancel", async () => {
    const t = { value: 2_000 };
    const { client } = fakeClient({ closeTime: t, cancelResult: "tecNO_PERMISSION" });
    const w = watcherWith(t, client);
    const failures: string[] = [];
    w.on("failed", (_e, err) => failures.push(err.message));
    w.track(escrow);
    await w.tick();
    expect(failures).toEqual(["EscrowCancel returned tecNO_PERMISSION"]);
    expect(w.pending()).toHaveLength(1);
  });

  it("never submits twice when ticks overlap", async () => {
    const t = { value: 2_000 };
    const { client, state } = fakeClient({ closeTime: t });
    const w = watcherWith(t, client);
    w.track(escrow);
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    expect(state.submitted).toHaveLength(1);
  });

  it("does not throw when nobody listens for failures", async () => {
    const t = { value: 2_000 };
    const client = {
      request: async () => {
        throw new Error("noNetwork");
      },
      submitAndWait: async () => ({}),
    } as unknown as ReclaimClient;
    const w = watcherWith(t, client);
    w.track(escrow);
    await expect(w.tick()).resolves.toBeUndefined();
  });
});

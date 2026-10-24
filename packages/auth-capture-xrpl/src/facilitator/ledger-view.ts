import { Client, RippledError, type LedgerEntryRequest } from "xrpl";

/** Account flags the facilitator cares about (AccountRoot.Flags). */
export const LSF_REQUIRE_DEST_TAG = 0x00020000;
export const LSF_DISABLE_MASTER = 0x00100000;
export const LSF_DEPOSIT_AUTH = 0x01000000;

export interface XrplAccountState {
  xrpDrops: string;
  /** AccountRoot OwnerCount; drives the owner reserve. */
  ownerCount: number;
  /** The next valid Sequence for this account. */
  sequence: number;
  flags: number;
}

/** Ledger reserves in drops. */
export interface XrplReserves {
  baseDrops: string;
  ownerIncrementDrops: string;
}

export interface SubmitResult {
  engineResult: string;
  validated: boolean;
  txHash: string;
}

/** The ledger reads and writes the facilitator needs. Injected in tests. */
export interface XrplLedgerView {
  /** Index of the latest validated ledger. */
  getLedgerIndex(): Promise<number>;
  /** Account state from the current ledger, or null when the account does not exist. */
  getAccountState(address: string): Promise<XrplAccountState | null>;
  getReserves(): Promise<XrplReserves>;
  hasTicket(address: string, ticketSequence: number): Promise<boolean>;
  /** Submit and wait for a final result. */
  submitBlob(blob: string): Promise<SubmitResult>;
  isAlive?(): boolean;
  disconnect(): Promise<void>;
}

export async function connectLedgerView(url: string): Promise<XrplLedgerView> {
  const client = new Client(url);
  client.on("error", () => {});
  await client.connect();
  return {
    getLedgerIndex: () => client.getLedgerIndex(),
    getAccountState: async (address) => {
      try {
        const info = await client.request({ command: "account_info", account: address, ledger_index: "current" });
        const data = info.result.account_data;
        return { xrpDrops: data.Balance, ownerCount: data.OwnerCount, sequence: data.Sequence, flags: data.Flags ?? 0 };
      } catch (err) {
        if (err instanceof RippledError && (err.data as { error?: string } | undefined)?.error === "actNotFound") return null;
        throw err;
      }
    },
    getReserves: async () => {
      const r = await client.request({ command: "server_state" });
      const v = r.result.state.validated_ledger;
      if (!v) throw new Error("server_state response missing validated_ledger");
      return { baseDrops: String(v.reserve_base), ownerIncrementDrops: String(v.reserve_inc) };
    },
    hasTicket: async (address, ticketSequence) => {
      try {
        // rippled takes { account, ticket_seq }; xrpl.js 5.3 types it differently, hence the cast.
        await client.request({
          command: "ledger_entry",
          ticket: { account: address, ticket_seq: ticketSequence },
          ledger_index: "current",
        } as unknown as LedgerEntryRequest);
        return true;
      } catch (err) {
        if (err instanceof RippledError && (err.data as { error?: string } | undefined)?.error === "entryNotFound") return false;
        throw err;
      }
    },
    submitBlob: async (blob) => {
      const r = await client.submitAndWait(blob);
      const meta = r.result.meta;
      const engineResult = typeof meta === "object" && meta !== null ? String(meta.TransactionResult) : "unknown";
      return { engineResult, validated: r.result.validated ?? false, txHash: r.result.hash };
    },
    isAlive: () => client.isConnected(),
    disconnect: () => client.disconnect(),
  };
}

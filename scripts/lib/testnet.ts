import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Client, Wallet } from "xrpl";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const ENV_PATH = resolve(REPO_ROOT, ".env");
export const DEFAULT_WS_URL = "wss://s.altnet.rippletest.net:51233";
export const EXPLORER = "https://testnet.xrpl.org";

export const ROLES = ["buyer", "seller", "arbiter", "facilitator"] as const;
export type Role = (typeof ROLES)[number];

export function txLink(hash: string): string {
  return `${EXPLORER}/transactions/${hash}`;
}

export function accountLink(address: string): string {
  return `${EXPLORER}/accounts/${address}`;
}

/** Refuses to run against anything that is not the XRPL testnet. */
export function assertTestnet(network: string | undefined): void {
  if (network !== undefined && network !== "xrpl:1") {
    throw new Error(`Refusing to run: XRPL_NETWORK is ${network}. These scripts are testnet-only (xrpl:1).`);
  }
}

export function wsUrl(): string {
  return process.env.XRPL_WS_URL || DEFAULT_WS_URL;
}

export async function connect(): Promise<Client> {
  const client = new Client(wsUrl(), { connectionTimeout: 15_000 });
  await client.connect();
  return client;
}

/** Loads the four role wallets from .env. Seeds are never printed. */
export function loadWallets(): Record<Role, Wallet> {
  if (!existsSync(ENV_PATH)) {
    throw new Error("No .env found. Run `pnpm testnet:setup` first.");
  }
  config({ path: ENV_PATH, quiet: true });
  assertTestnet(process.env.XRPL_NETWORK);
  const wallets = {} as Record<Role, Wallet>;
  for (const role of ROLES) {
    const seed = process.env[`${role.toUpperCase()}_SEED`];
    if (!seed) throw new Error(`${role.toUpperCase()}_SEED is missing from .env. Run \`pnpm testnet:setup --force\`.`);
    wallets[role] = Wallet.fromSeed(seed);
  }
  return wallets;
}

export function envHasAllSeeds(): boolean {
  if (!existsSync(ENV_PATH)) return false;
  const text = readFileSync(ENV_PATH, "utf8");
  return ROLES.every((role) => new RegExp(`^${role.toUpperCase()}_SEED=\\S+`, "m").test(text));
}

export async function xrpBalance(client: Client, address: string): Promise<string> {
  try {
    return String(await client.getXrpBalance(address));
  } catch {
    return "not found";
  }
}

/** Close time (Ripple seconds) of the latest validated ledger. Escrow time checks use the parent ledger's close time. */
export async function validatedCloseTime(client: Client): Promise<number> {
  const res = await client.request({ command: "ledger", ledger_index: "validated" });
  return res.result.ledger.close_time;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

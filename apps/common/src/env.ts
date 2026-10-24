import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Wallet } from "xrpl";

/**
 * Shared config for the demo apps. Everything comes from the repo-root .env that
 * `pnpm testnet:setup` writes. Seeds are read here and never logged.
 */

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const NETWORK = "xrpl:1" as const;
export const DEFAULT_WS_URL = "wss://s.altnet.rippletest.net:51233";
export const EXPLORER = "https://testnet.xrpl.org";

export const PORTS = {
  facilitator: Number(process.env.FACILITATOR_PORT ?? 4020),
  arbiter: Number(process.env.ARBITER_PORT ?? 4030),
  seller: Number(process.env.SELLER_PORT ?? 4040),
  demo: Number(process.env.DEMO_PORT ?? 4050),
};

export const URLS = {
  facilitator: process.env.FACILITATOR_URL ?? `http://localhost:${PORTS.facilitator}`,
  arbiter: process.env.ARBITER_URL ?? `http://localhost:${PORTS.arbiter}`,
  seller: process.env.SELLER_URL ?? `http://localhost:${PORTS.seller}`,
  demo: process.env.DEMO_URL ?? `http://localhost:${PORTS.demo}`,
};

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  const path = resolve(REPO_ROOT, ".env");
  if (existsSync(path)) config({ path, quiet: true });
  loaded = true;
  const network = process.env.XRPL_NETWORK;
  if (network !== undefined && network !== NETWORK) {
    throw new Error(`Refusing to run: XRPL_NETWORK is ${network}. The demo is testnet-only (${NETWORK}).`);
  }
}

export function wsUrl(): string {
  loadEnv();
  return process.env.XRPL_WS_URL || DEFAULT_WS_URL;
}

export type Role = "buyer" | "seller" | "arbiter" | "facilitator";

export function wallet(role: Role): Wallet {
  loadEnv();
  const seed = process.env[`${role.toUpperCase()}_SEED`];
  if (!seed) throw new Error(`${role.toUpperCase()}_SEED is missing. Run \`pnpm testnet:setup\` first.`);
  return Wallet.fromSeed(seed);
}

export function address(role: Role): string {
  loadEnv();
  return process.env[`${role.toUpperCase()}_ADDRESS`] || wallet(role).classicAddress;
}

export function txLink(hash: string): string {
  return `${EXPLORER}/transactions/${hash}`;
}

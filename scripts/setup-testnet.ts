/**
 * Creates and funds the four demo wallets on the XRPL testnet and writes them to .env.
 *
 *   pnpm testnet:setup          # first run, or print balances if .env already has wallets
 *   pnpm testnet:setup --force  # replace the wallets with new ones
 *
 * Seeds go only into .env (gitignored, mode 600). They are never printed.
 */
import { writeFileSync } from "node:fs";
import type { Wallet } from "xrpl";
import {
  DEFAULT_WS_URL,
  ENV_PATH,
  ROLES,
  type Role,
  accountLink,
  connect,
  envHasAllSeeds,
  loadWallets,
  wsUrl,
  xrpBalance,
} from "./lib/testnet.js";

const force = process.argv.includes("--force");

async function main(): Promise<void> {
  const client = await connect();
  try {
    let wallets: Record<Role, Wallet>;
    if (envHasAllSeeds() && !force) {
      console.log(".env already has all four wallets; showing balances (use --force to replace them).\n");
      wallets = loadWallets();
    } else {
      wallets = {} as Record<Role, Wallet>;
      for (const role of ROLES) {
        process.stdout.write(`Funding ${role} from the testnet faucet... `);
        const { wallet } = await client.fundWallet();
        wallets[role] = wallet;
        console.log("done");
      }
      writeEnv(wallets);
      console.log(`\nWrote ${ENV_PATH} (seeds inside; never commit or share it).\n`);
    }

    console.log("role         address                               balance (XRP)");
    for (const role of ROLES) {
      const address = wallets[role].classicAddress;
      console.log(`${role.padEnd(12)} ${address.padEnd(37)} ${await xrpBalance(client, address)}`);
    }
    console.log("");
    for (const role of ROLES) console.log(`${role}: ${accountLink(wallets[role].classicAddress)}`);
  } finally {
    await client.disconnect();
  }
}

function writeEnv(wallets: Record<Role, Wallet>): void {
  const lines = [
    "# Written by scripts/setup-testnet.ts. Testnet only; never reuse these accounts on mainnet.",
    "XRPL_NETWORK=xrpl:1",
    `XRPL_WS_URL=${wsUrl() || DEFAULT_WS_URL}`,
    "",
  ];
  for (const role of ROLES) {
    const key = role.toUpperCase();
    lines.push(`${key}_ADDRESS=${wallets[role].classicAddress}`);
    lines.push(`${key}_SEED=${wallets[role].seed}`);
  }
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

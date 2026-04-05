#!/usr/bin/env tsx

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Transaction, AbiCoder } from "ethers";
import { getWallet } from "@open-wallet-standard/core";

// Load .env from ~/.ows/policies/
function loadEnv() {
  const envPath = join(homedir(), ".ows", "policies", ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}
loadEnv();

const TIER_LIMITS: Record<string, number> = {
  new: 5,
  established: 50,
  trusted: 500,
  verified: 5000,
};

const HIGH_VALUE_THRESHOLD = 1000;

// Tier thresholds must match server's scoring.ts

// ERC-20 transfer(address,uint256) selector
const TRANSFER_SELECTOR = "a9059cbb";

// Dangerous selectors — these grant third-party access to wallet assets
// A rogue agent could call approve(attacker, MAX_UINT) then drain via transferFrom
const DANGEROUS_SELECTORS: Record<string, string> = {
  "095ea7b3": "approve(address,uint256)",
  "39509351": "increaseAllowance(address,uint256)",
  "a22cb465": "setApprovalForAll(address,bool)",
  "d505accf": "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "2a55205a": "approve(address,uint256)",  // some ERC-721 variants
};

// Known stablecoins on Base (address → decimals)
// These are always $1 per token
const STABLECOINS: Record<string, number> = {
  // Base Mainnet
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": 6, // USDT
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": 18, // DAI
  // Base Sepolia (testnet)
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": 6, // USDC (sepolia)
};

// Fetch live ETH price from CoinGecko (free, no auth)
async function fetchEthPrice(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(2000) }
    );
    const data = (await res.json()) as { ethereum: { usd: number } };
    return data.ethereum.usd;
  } catch {
    return 3000; // fallback
  }
}

// Parse raw tx to extract: real recipient, USD value, and whether it's a token transfer
function parseTx(rawHex: string): {
  to: string;
  realTo: string;
  value: bigint;
  isErc20: boolean;
  tokenContract: string;
  tokenAmount: bigint;
  tokenDecimals: number | null;
  isDangerous: boolean;
  dangerousFunction: string | null;
} {
  try {
    const tx = Transaction.from("0x" + rawHex);
    const to = (tx.to ?? "").toLowerCase();
    const data = tx.data ?? "0x";

    const selector = data.length >= 10 ? data.slice(2, 10) : "";

    // Check for dangerous selectors (approve, increaseAllowance, etc.)
    if (selector && DANGEROUS_SELECTORS[selector]) {
      return {
        to, realTo: to, value: tx.value,
        isErc20: false, tokenContract: to, tokenAmount: 0n, tokenDecimals: null,
        isDangerous: true, dangerousFunction: DANGEROUS_SELECTORS[selector],
      };
    }

    // Check if this is an ERC-20 transfer(address,uint256)
    if (data.length >= 138 && selector === TRANSFER_SELECTOR) {
      const decoded = AbiCoder.defaultAbiCoder().decode(
        ["address", "uint256"],
        "0x" + data.slice(10)
      );
      const recipient = (decoded[0] as string).toLowerCase();
      const amount = decoded[1] as bigint;
      const decimals = STABLECOINS[to] ?? null;

      return {
        to, realTo: recipient, value: tx.value,
        isErc20: true, tokenContract: to, tokenAmount: amount, tokenDecimals: decimals,
        isDangerous: false, dangerousFunction: null,
      };
    }

    return {
      to, realTo: to, value: tx.value,
      isErc20: false, tokenContract: "", tokenAmount: 0n, tokenDecimals: null,
      isDangerous: false, dangerousFunction: null,
    };
  } catch {
    return {
      to: "", realTo: "", value: 0n,
      isErc20: false, tokenContract: "", tokenAmount: 0n, tokenDecimals: null,
      isDangerous: false, dangerousFunction: null,
    };
  }
}

// Calculate USD value of a transaction
async function txToUsd(parsed: ReturnType<typeof parseTx>): Promise<number> {
  let usd = 0;

  // Native ETH value
  if (parsed.value > 0n) {
    const ethPrice = await fetchEthPrice();
    usd += Number(parsed.value) / 1e18 * ethPrice;
  }

  // ERC-20 token value
  if (parsed.isErc20 && parsed.tokenAmount > 0n) {
    if (parsed.tokenDecimals !== null) {
      // Known stablecoin — $1 per token
      usd += Number(parsed.tokenAmount) / 10 ** parsed.tokenDecimals;
    }
    // Unknown token — we can't price it, treat as $0
    // This means unknown tokens always pass the spend limit
    // In production, use a price oracle for all tokens
  }

  return usd;
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const ctx = JSON.parse(Buffer.concat(chunks).toString()) as {
    wallet_id: string;
    chain_id: string;
    transaction: {
      to: string | null;
      value: string | null;
      raw_hex: string;
      data: string | null;
    };
    api_key_id: string;
    timestamp: string;
  };

  const sentinelUrl = process.env.SENTINEL_URL!;
  const walletSig = process.env.WALLET_SIG!;

  // Resolve wallet UUID → EVM address
  let walletAddress = process.env.WALLET_ADDRESS || ctx.wallet_id;
  try {
    const wallet = getWallet(ctx.wallet_id);
    const evmAccount = wallet.accounts.find(
      (a: { chainId: string; address: string }) => a.chainId.startsWith("eip155:")
    );
    if (evmAccount) {
      walletAddress = evmAccount.address.toLowerCase();
    }
  } catch {
    // wallet not found locally — use wallet_id as-is
  }

  // Parse the raw transaction
  const parsed = parseTx(ctx.transaction.raw_hex);
  const to = parsed.realTo;
  const txValueUsd = await txToUsd(parsed);

  // Block dangerous calls (approve, increaseAllowance, etc.) — always queue for approval
  if (parsed.isDangerous) {
    const reason = `dangerous_call:${parsed.dangerousFunction} on ${parsed.tokenContract.slice(0, 10)}...`;
    process.stderr.write(`SENTINEL: BLOCKED ${parsed.dangerousFunction} on ${parsed.tokenContract}\n`);

    try {
      const res = await fetch(`${sentinelUrl}/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Sig": walletSig, "X-Wallet-Address": walletAddress,
        },
        body: JSON.stringify({
          wallet_id: walletAddress, to: parsed.to,
          value: "0", chain_id: ctx.chain_id,
          raw_hex: ctx.transaction.raw_hex,
          reason, tier: "n/a", score: 0,
        }),
        signal: AbortSignal.timeout(2000),
      });
      const { id } = (await res.json()) as { id: string };
      output({ allow: false, reason: `queued:${id}:${reason}` });
    } catch {
      output({ allow: false, reason });
    }
    return;
  }

  // 1. Fetch reputation score
  let rep: {
    score: number;
    tier: string;
    today_spent: number;
    spend_limit: number;
    approved_to: boolean;
  };

  try {
    const url = `${sentinelUrl}/reputation/${walletAddress}${to ? `?to=${to}` : ""}`;
    const res = await fetch(url, {
      headers: { "X-Wallet-Sig": walletSig, "X-Wallet-Address": walletAddress },
      signal: AbortSignal.timeout(2000),
    });
    rep = (await res.json()) as typeof rep;
  } catch (e) {
    output({ allow: false, reason: `sentinel_unavailable:${e}` });
    return;
  }

  const tierLimit = TIER_LIMITS[rep.tier] ?? TIER_LIMITS.new;
  const todaySpend = rep.today_spent ?? 0;

  const txType = parsed.isErc20 ? `ERC20(${parsed.tokenContract.slice(0, 10)}...)` : "ETH";
  process.stderr.write(`SENTINEL: wallet=${walletAddress.slice(0, 10)}... ${txType} to=${to.slice(0, 10)}... usd=$${txValueUsd.toFixed(2)} tier=${rep.tier} limit=$${tierLimit} spent=$${todaySpend}\n`);

  // 2. If this tx was previously approved via Telegram, allow it
  if (rep.approved_to) {
    reportAudit(sentinelUrl, walletSig, walletAddress, ctx.chain_id, txValueUsd, "allow", "human_approved");
    output({ allow: true });
    return;
  }

  // 3. Check if tx should be denied
  let denyReason: string | null = null;

  if (todaySpend + txValueUsd > tierLimit) {
    denyReason = `spend_limit:$${txValueUsd.toFixed(2)}+$${todaySpend.toFixed(2)}>$${tierLimit}(${rep.tier})`;
  } else if (txValueUsd > HIGH_VALUE_THRESHOLD && rep.tier !== "verified") {
    denyReason = `high_value:$${txValueUsd.toFixed(2)}(${rep.tier})`;
  }

  // 4. If denied → queue for human approval via Telegram
  if (denyReason) {
    try {
      const res = await fetch(`${sentinelUrl}/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Sig": walletSig, "X-Wallet-Address": walletAddress,
        },
        body: JSON.stringify({
          wallet_id: walletAddress,
          to,
          value: txValueUsd.toFixed(2),
          chain_id: ctx.chain_id,
          raw_hex: ctx.transaction.raw_hex,
          reason: denyReason,
          tier: rep.tier,
          score: rep.score,
        }),
        signal: AbortSignal.timeout(2000),
      });
      const { id } = (await res.json()) as { id: string };
      reportAudit(sentinelUrl, walletSig, walletAddress, ctx.chain_id, txValueUsd, "deny", `queued:${id}:${denyReason}`);
      output({ allow: false, reason: `queued:${id}:${denyReason}` });
    } catch (e) {
      reportAudit(sentinelUrl, walletSig, walletAddress, ctx.chain_id, txValueUsd, "deny", denyReason);
      output({ allow: false, reason: denyReason });
    }
    return;
  }

  // 5. Allow
  reportAudit(sentinelUrl, walletSig, walletAddress, ctx.chain_id, txValueUsd, "allow");
  output({ allow: true });
}

function output(result: { allow: boolean; reason?: string }) {
  process.stdout.write(JSON.stringify(result));
}

function reportAudit(
  sentinelUrl: string,
  walletSig: string,
  walletId: string,
  chainId: string,
  txValueUsd: number,
  action: "allow" | "deny",
  reason?: string
) {
  fetch(`${sentinelUrl}/audit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Wallet-Sig": walletSig, "X-Wallet-Address": walletId,
    },
    body: JSON.stringify({
      wallet_id: walletId,
      action,
      reason,
      tx_value: txValueUsd.toFixed(2),
      chain_id: chainId,
    }),
  }).catch(() => {});
}

main();

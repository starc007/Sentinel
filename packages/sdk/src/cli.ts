#!/usr/bin/env node

import { copyFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execSync } from "child_process";
import { createInterface } from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SENTINEL_SERVER_URL = "https://sentinel-server.saurabh10102.workers.dev";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    throw new Error(e.stderr?.trim() || e.message);
  }
}

function log(msg: string) {
  console.log(msg);
}

async function init() {
  log("\n  Sentinel Setup\n");
  log("  FICO scores for AI agent wallets.\n");

  // 1. Check OWS CLI + tsx
  try {
    run("ows --version");
  } catch {
    log("  OWS CLI not found. Install it first:");
    log("  curl -fsSL https://docs.openwallet.sh/install.sh | bash\n");
    process.exit(1);
  }

  let tsxPath: string;
  try {
    tsxPath = run("which tsx");
  } catch {
    log("  tsx not found. Installing globally...");
    run("npm install -g tsx");
    tsxPath = run("which tsx");
  }

  log("  [1/6] OWS CLI + tsx found\n");

  // 2. Get or create wallet
  const walletList = run("ows wallet list");
  let walletName: string;

  if (walletList.includes("No wallets found")) {
    log("  No wallets found. Creating one...\n");
    walletName = (await prompt("  Wallet name (press Enter for 'sentinel-agent'): ")) || "sentinel-agent";
    log("");
    const result = run(`ows wallet create --name "${walletName}"`);
    const evmMatch = result.match(/eip155:1.*→\s*(0x[0-9a-fA-F]+)/);
    if (evmMatch) {
      log(`  [2/6] Wallet created: ${walletName}`);
      log(`         EVM address: ${evmMatch[1]}\n`);
    } else {
      log(`  [2/6] Wallet created: ${walletName}\n`);
    }
  } else {
    const names = walletList.match(/Name:\s+(\S+)/g)?.map((m) => m.replace("Name:", "").trim()) ?? [];
    if (names.length === 1) {
      walletName = names[0];
      log(`  [2/6] Using wallet: ${walletName}\n`);
    } else {
      log("  Available wallets:");
      names.forEach((n) => log(`    - ${n}`));
      log("");
      walletName = await prompt("  Which wallet? ");
      if (!walletName) {
        log("  Wallet name required.");
        process.exit(1);
      }
      log(`\n  [2/6] Using wallet: ${walletName}\n`);
    }
  }

  // 3. Install policy files + deps
  const policiesDir = join(homedir(), ".ows", "policies");
  if (!existsSync(policiesDir)) {
    mkdirSync(policiesDir, { recursive: true });
  }

  const policyTsPath = join(policiesDir, "reputation-policy.ts");
  const sourcePaths = [
    join(__dirname, "..", "..", "policies", "src", "reputation-policy.ts"),
    join(__dirname, "..", "policy", "reputation-policy.ts"),
  ];
  const sourcePath = sourcePaths.find((p) => existsSync(p));
  if (sourcePath) {
    copyFileSync(sourcePath, policyTsPath);
  } else {
    log("  Policy file not found. Please reinstall ows-sentinel-sdk.");
    process.exit(1);
  }

  const policyShPath = join(policiesDir, "reputation-policy.sh");
  writeFileSync(policyShPath, [
    `#!/bin/bash`,
    `export NODE_PATH="${policiesDir}/node_modules"`,
    `exec "${tsxPath}" "${policyTsPath}"`,
    ``,
  ].join("\n"));
  execSync(`chmod +x "${policyShPath}"`);

  log("  [3/6] Installing policy dependencies...\n");
  execSync(`cd "${policiesDir}" && npm init -y --silent 2>/dev/null; npm install ethers @open-wallet-standard/core --silent 2>/dev/null`, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // 4. Sign auth message with wallet — proves ownership, no shared secrets
  // Resolve wallet EVM address
  const walletInfo = run(`ows wallet list`);
  const evmMatch = walletInfo.match(/eip155:1.*→\s*(0x[0-9a-fA-F]+)/);
  const walletAddress = evmMatch ? evmMatch[1].toLowerCase() : "";

  if (!walletAddress) {
    log("  Could not resolve EVM address from wallet.");
    process.exit(1);
  }

  // Sign "sentinel:{address}" — server verifies by recovering the signer
  const authMessage = `sentinel:${walletAddress}`;
  const sigResult = JSON.parse(run(
    `node -e "const{signMessage}=require('@open-wallet-standard/core');console.log(JSON.stringify(signMessage('${walletName}','evm','${authMessage}')))"  `
  )) as { signature: string };
  const walletSig = "0x" + sigResult.signature;

  // Write .env for the policy
  const envPath = join(policiesDir, ".env");
  writeFileSync(envPath, [
    `SENTINEL_URL=${SENTINEL_SERVER_URL}`,
    `WALLET_ADDRESS=${walletAddress}`,
    `WALLET_SIG=${walletSig}`,
    ``,
  ].join("\n"));

  log(`  [4/6] Policy installed + wallet signature created\n`);
  log(`         Address: ${walletAddress}\n`);

  // 5. Register policy with OWS
  const policyJson = {
    id: "sentinel-reputation",
    name: "Sentinel Reputation Gate",
    version: 1,
    created_at: new Date().toISOString(),
    rules: [
      { type: "allowed_chains", chain_ids: ["eip155:8453", "eip155:84532"] },
    ],
    executable: policyShPath,
    action: "deny",
  };

  const policyJsonPath = join(policiesDir, "sentinel-policy.json");
  writeFileSync(policyJsonPath, JSON.stringify(policyJson, null, 2));

  try {
    run(`ows policy create --file "${policyJsonPath}"`);
    log("  [5/6] Policy registered with OWS\n");
  } catch (e: any) {
    if (e.message.includes("already exists")) {
      log("  [5/6] Policy already registered\n");
    } else {
      log(`  Failed to register policy: ${e.message}`);
      process.exit(1);
    }
  }

  // 6. Create API key
  try {
    const keyResult = run(
      `ows key create --name "sentinel-${walletName}" --wallet "${walletName}" --policy sentinel-reputation`
    );

    const tokenMatch = keyResult.match(/ows_key_[a-zA-Z0-9_-]+/);
    const token = tokenMatch?.[0] ?? "(see output above)";

    log("  [6/7] API key created\n");
    log("  ----------------------------------------");
    log(`  API Key: ${token}`);
    log("  Save this — it won't be shown again.");
    log("  ----------------------------------------\n");

    // 7. Telegram linking
    const botDeepLink = `https://t.me/ows_sentinelBot?start=${walletAddress}`;

    log("  [7/7] Link Telegram for approval notifications\n");
    log("  Click this link to connect your wallet to Telegram:\n");
    log(`  ${botDeepLink}\n`);
    log("  (Or open Telegram → @ows_sentinelBot → tap Start)\n");

    await prompt("  Press Enter after you've linked...");

    log("  ----------------------------------------");
    log("  Setup complete!");
    log("  ----------------------------------------\n");
    log("  Use in your agent:\n");
    log("  ```typescript");
    log('  import { signWithApproval } from "ows-sentinel-sdk"');
    log('  import { signTransaction } from "@open-wallet-standard/core"');
    log("");
    log("  const tx = await signWithApproval(");
    log(`    () => signTransaction("${walletName}", "eip155:84532", txHex, "${token}"),`);
    log(`    { inboxUrl: "${SENTINEL_SERVER_URL}" }`);
    log("  )");
    log("  ```\n");
    log("  Reputation tiers:");
    log("    New ($5/day) -> Established ($50/day) -> Trusted ($500/day) -> Verified ($5k/day)\n");
    log("  Transactions over the limit need your approval on Telegram.\n");
  } catch (e: any) {
    log(`  Failed to create API key: ${e.message}`);
    process.exit(1);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "init") {
    await init();
  } else {
    log("Usage: npx ows-sentinel init");
    log("  Sets up Sentinel reputation policy on your OWS wallet");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

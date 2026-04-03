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

  // 1. Check OWS CLI is installed
  try {
    run("ows --version");
  } catch {
    log("  OWS CLI not found. Install it first:");
    log("  curl -fsSL https://docs.openwallet.sh/install.sh | bash\n");
    process.exit(1);
  }
  log("  [1/5] OWS CLI found\n");

  // 2. Get or create wallet
  const walletList = run("ows wallet list");
  let walletName: string;

  if (walletList.includes("No wallets found")) {
    log("  No wallets found. Creating one...\n");
    walletName = (await prompt("  Wallet name (press Enter for 'sentinel-agent'): ")) || "sentinel-agent";
    log("");
    const result = run(`ows wallet create --name "${walletName}"`);
    // Extract the EVM address
    const evmMatch = result.match(/eip155:1.*→\s*(0x[0-9a-fA-F]+)/);
    if (evmMatch) {
      log(`  [2/5] Wallet created: ${walletName}`);
      log(`         EVM address: ${evmMatch[1]}\n`);
    } else {
      log(`  [2/5] Wallet created: ${walletName}\n`);
    }
  } else {
    // Parse wallet names from the list
    const names = walletList.match(/Name:\s+(\S+)/g)?.map((m) => m.replace("Name:", "").trim()) ?? [];

    if (names.length === 1) {
      walletName = names[0];
      log(`  [2/5] Using wallet: ${walletName}\n`);
    } else {
      log("  Available wallets:");
      names.forEach((n) => log(`    - ${n}`));
      log("");
      walletName = await prompt("  Which wallet? ");
      if (!walletName) {
        log("  Wallet name required.");
        process.exit(1);
      }
      log(`\n  [2/5] Using wallet: ${walletName}\n`);
    }
  }

  // 3. Copy policy executable + write policy JSON
  const policiesDir = join(homedir(), ".ows", "policies");
  if (!existsSync(policiesDir)) {
    mkdirSync(policiesDir, { recursive: true });
  }

  const policyPath = join(policiesDir, "reputation-policy.ts");

  // Try monorepo path first, then bundled path
  const sourcePaths = [
    join(__dirname, "..", "..", "policies", "src", "reputation-policy.ts"),
    join(__dirname, "..", "policy", "reputation-policy.ts"),
  ];
  const sourcePath = sourcePaths.find((p) => existsSync(p));

  if (sourcePath) {
    copyFileSync(sourcePath, policyPath);
  } else {
    log("  Policy file not found. Please reinstall ows-sentinel-sdk.");
    process.exit(1);
  }

  // Register with Sentinel server to get a key
  let sentinelKey: string;
  try {
    const res = await fetch(`${SENTINEL_SERVER_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: walletName }),
    });

    if (res.ok) {
      const data = (await res.json()) as { key: string };
      sentinelKey = data.key;
    } else {
      // Server doesn't have /register yet — generate a local key
      sentinelKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    sentinelKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Write policy JSON
  const policyJson = {
    id: "sentinel-reputation",
    name: "Sentinel Reputation Gate",
    version: 1,
    created_at: new Date().toISOString(),
    rules: [
      { type: "allowed_chains", chain_ids: ["eip155:8453", "eip155:84532"] },
    ],
    executable: policyPath,
    action: "deny",
  };

  const policyJsonPath = join(policiesDir, "sentinel-policy.json");
  writeFileSync(policyJsonPath, JSON.stringify(policyJson, null, 2));

  // Write env file for the policy executable
  const envPath = join(policiesDir, ".env");
  writeFileSync(envPath, `SENTINEL_URL=${SENTINEL_SERVER_URL}\nSENTINEL_KEY=${sentinelKey}\n`);

  log(`  [3/5] Policy installed to ${policiesDir}\n`);

  // 4. Register policy with OWS
  try {
    run(`ows policy create --file "${policyJsonPath}"`);
    log("  [4/5] Policy registered with OWS\n");
  } catch (e: any) {
    if (e.message.includes("already exists")) {
      log("  [4/5] Policy already registered\n");
    } else {
      log(`  Failed to register policy: ${e.message}`);
      process.exit(1);
    }
  }

  // 5. Create API key with policy attached
  try {
    const keyResult = run(
      `ows key create --name "sentinel-${walletName}" --wallet "${walletName}" --policy sentinel-reputation`
    );

    const tokenMatch = keyResult.match(/ows_key_[a-zA-Z0-9_-]+/);
    const token = tokenMatch?.[0] ?? "(see output above)";

    log("  [5/5] API key created\n");
    log("  ----------------------------------------");
    log(`  API Key: ${token}`);
    log("  Save this — it won't be shown again.");
    log("  ----------------------------------------\n");

    // Print usage
    log("  Setup complete! Use in your agent:\n");
    log("  ```typescript");
    log('  import { signWithApproval } from "ows-sentinel-sdk"');
    log("");
    log(`  // Set OWS_API_KEY=${token} in your environment`);
    log("  const tx = await signWithApproval(");
    log(`    () => ows.signAndSend("${walletName}", "evm", txHex),`);
    log("    {");
    log(`      inboxUrl: "${SENTINEL_SERVER_URL}",`);
    log(`      sentinelKey: "${sentinelKey}",`);
    log("    }");
    log("  )");
    log("  ```\n");
    log("  Reputation tiers:");
    log("    New ($5/day) -> Established ($50/day) -> Trusted ($500/day) -> Verified ($5k/day)\n");
    log("  High-value txs (>$1k) need Telegram approval.\n");
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

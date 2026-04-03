#!/usr/bin/env node

import { copyFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { createInterface } from "readline";

const SENTINEL_SERVER_URL = "https://sentinel-server.saurabh10102.workers.dev";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    throw new Error(`Command failed: ${cmd}\n${e.stderr ?? e.message}`);
  }
}

async function init() {
  console.log("\n🛡️  Sentinel Setup\n");

  // 1. Check OWS CLI
  try {
    run("ows --version");
  } catch {
    console.error("❌ OWS CLI not found. Install it first:");
    console.error("   curl -fsSL https://docs.openwallet.sh/install.sh | bash");
    process.exit(1);
  }

  // 2. Check for existing wallets
  const walletList = run("ows wallet list");
  let walletName: string;

  if (walletList.includes("No wallets found")) {
    console.log("No OWS wallets found. Creating one...\n");
    walletName = (await prompt("Wallet name (default: sentinel-agent): ")) || "sentinel-agent";
    const result = run(`ows wallet create --name "${walletName}"`);
    console.log(result);
    console.log("");
  } else {
    console.log("Existing wallets:");
    console.log(walletList);
    console.log("");
    walletName = await prompt("Wallet name to use: ");
    if (!walletName) {
      console.error("❌ Wallet name required");
      process.exit(1);
    }
  }

  // 3. Copy policy executable
  const policiesDir = join(homedir(), ".ows", "policies");
  if (!existsSync(policiesDir)) {
    mkdirSync(policiesDir, { recursive: true });
  }

  const policyPath = join(policiesDir, "reputation-policy.ts");
  const sourcePath = join(__dirname, "..", "..", "policies", "src", "reputation-policy.ts");

  if (existsSync(sourcePath)) {
    copyFileSync(sourcePath, policyPath);
  } else {
    // When installed via npm, the policy is bundled alongside
    const bundledPath = join(__dirname, "..", "policy", "reputation-policy.ts");
    if (existsSync(bundledPath)) {
      copyFileSync(bundledPath, policyPath);
    } else {
      console.error("❌ Policy file not found. Download it from:");
      console.error("   https://github.com/starc007/ows-sentinel/blob/main/packages/policies/src/reputation-policy.ts");
      console.error(`   Save to: ${policyPath}`);
      process.exit(1);
    }
  }
  console.log(`✅ Policy copied to ${policyPath}`);

  // 4. Get sentinel key
  const sentinelKey = await prompt("Sentinel API key (get from sentinel admin): ");
  if (!sentinelKey) {
    console.error("❌ Sentinel key required");
    process.exit(1);
  }

  // 5. Register policy with OWS
  const policyJson = {
    id: "sentinel-reputation",
    name: "Sentinel Reputation Gate",
    version: 1,
    rules: [
      { type: "allowed_chains", chain_ids: ["eip155:8453", "eip155:84532"] },
    ],
    executable: policyPath,
    action: "deny",
  };

  const policyJsonPath = join(policiesDir, "sentinel-policy.json");
  writeFileSync(policyJsonPath, JSON.stringify(policyJson, null, 2));

  try {
    const result = run(`ows policy create --file "${policyJsonPath}"`);
    console.log(`✅ Policy registered: ${result}`);
  } catch (e: any) {
    if (e.message.includes("already exists")) {
      console.log("✅ Policy already registered");
    } else {
      console.error(`❌ Failed to register policy: ${e.message}`);
      process.exit(1);
    }
  }

  // 6. Create API key with policy attached
  console.log("");
  const keyName = (await prompt("API key name (default: sentinel-agent-key): ")) || "sentinel-agent-key";

  try {
    const result = run(
      `ows key create --name "${keyName}" --wallet "${walletName}" --policy sentinel-reputation`
    );
    console.log(`✅ API key created`);
    console.log(result);

    // Extract the token from output
    const tokenMatch = result.match(/ows_key_[a-zA-Z0-9]+/);
    if (tokenMatch) {
      console.log(`\n🔑 API Key Token: ${tokenMatch[0]}`);
      console.log("   Save this — it won't be shown again.");
    }
  } catch (e: any) {
    console.error(`❌ Failed to create API key: ${e.message}`);
    process.exit(1);
  }

  // 7. Write env file for the policy
  const envPath = join(homedir(), ".ows", "policies", ".env");
  writeFileSync(envPath, [
    `SENTINEL_URL=${SENTINEL_SERVER_URL}`,
    `SENTINEL_KEY=${sentinelKey}`,
    "",
  ].join("\n"));
  console.log(`\n✅ Policy env written to ${envPath}`);

  // 8. Done
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Setup complete!

 Your agent wallet is now protected by Sentinel.

 Usage in your agent code:

   import { signWithApproval } from "ows-sentinel-sdk"
   import { signAndSend } from "@open-wallet-standard/core"

   const tx = await signWithApproval(
     () => signAndSend("${walletName}", "evm", txHex),
     {
       inboxUrl: "${SENTINEL_SERVER_URL}",
       sentinelKey: "${sentinelKey}",
     }
   )

 Reputation tiers:
   New ($5/day) → Established ($50/day) → Trusted ($500/day) → Verified ($5k/day)

 High-value txs (>$1k) will need Telegram approval.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

async function main() {
  const command = process.argv[2];

  if (command === "init") {
    await init();
  } else {
    console.log("Usage: ows-sentinel init");
    console.log("  Sets up Sentinel policy on your OWS wallet");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

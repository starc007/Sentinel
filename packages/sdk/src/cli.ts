#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function main() {
  const command = process.argv[2];

  if (command === "init") {
    const owsDir = join(homedir(), ".ows", "policies");

    if (!existsSync(owsDir)) {
      mkdirSync(owsDir, { recursive: true });
    }

    const policyPath = join(owsDir, "reputation-policy.ts");
    const sourcePath = join(__dirname, "..", "..", "policies", "src", "reputation-policy.ts");

    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, policyPath);
      console.log(`Policy copied to: ${policyPath}`);
    } else {
      console.log("Policy file not found in package. Copy manually from:");
      console.log("  packages/policies/src/reputation-policy.ts");
    }

    console.log("\nSetup required environment variables:");
    console.log("  SENTINEL_URL=https://sentinel-server.your-domain.workers.dev");
    console.log("  SENTINEL_KEY=your-secret-key");
    console.log("\nAdd the policy to your OWS API key configuration.");
  } else {
    console.log("Usage: ows-sentinel init");
    console.log("  Copies Sentinel policy to ~/.ows/policies/");
  }
}

main();

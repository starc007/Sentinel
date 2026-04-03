export type ApprovalRequestData = {
  walletId: string;
  tier: string;
  value: string;
  to: string;
  chainId: string;
  score: number;
  reason: string;
};

export function formatApprovalRequest(data: ApprovalRequestData): string {
  const tierDisplay = data.tier ? data.tier.charAt(0).toUpperCase() + data.tier.slice(1) : "Unknown";
  const chain = data.chainId?.includes("8453") ? "Base" : (data.chainId ?? "Unknown");
  const toShort = data.to ? `${data.to.slice(0, 6)}...${data.to.slice(-4)}` : "unknown";

  // Determine denial type from reason
  let reasonDisplay: string;
  if (data.reason?.includes("spend_limit")) {
    reasonDisplay = "Spend limit exceeded for this tier";
  } else if (data.reason?.includes("high_value")) {
    reasonDisplay = "High-value tx requires approval";
  } else {
    reasonDisplay = data.reason ?? "Policy denied";
  }

  return [
    `🚨 <b>Transaction Blocked — Approval Needed</b>`,
    ``,
    `<b>Agent</b>    ${data.walletId.slice(0, 10)}...`,
    `<b>To</b>       ${toShort}`,
    `<b>Amount</b>   $${data.value} on ${chain}`,
    `<b>Tier</b>     ${tierDisplay}`,
    `<b>Score</b>    ${data.score}/100`,
    ``,
    `<b>Reason:</b> ${reasonDisplay}`,
    ``,
    `Approve to allow this transaction through.`,
  ].join("\n");
}

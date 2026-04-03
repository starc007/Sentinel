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
    `<b>From</b>     <code>${data.walletId}</code>`,
    `<b>To</b>       <code>${data.to}</code>`,
    `<b>Amount</b>   $${data.value} on ${chain}`,
    `<b>Tier</b>     ${tierDisplay}`,
    `<b>Score</b>    ${data.score}/100`,
    ``,
    `<b>Reason:</b> ${reasonDisplay}`,
    ``,
    `<b>Status:</b> ⏳ Pending`,
  ].join("\n");
}

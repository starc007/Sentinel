export type SpendLimitAlertData = {
  walletId: string;
  tier: string;
  tierLimit: number;
  todaySpent: number;
  attemptedValue: number;
  score: number;
};

export function formatSpendLimitAlert(data: SpendLimitAlertData): string {
  const tierDisplay = data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
  return [
    `⚠️ <b>Spend Limit Reached</b>`,
    ``,
    `<b>Agent</b>      ${data.walletId}`,
    `<b>Tier</b>       ${tierDisplay} ($${data.tierLimit}/day)`,
    `<b>Spent</b>      $${data.todaySpent.toFixed(2)} today`,
    `<b>Attempted</b>  $${data.attemptedValue.toFixed(2)} more → <b>DENIED</b>`,
    ``,
    `Score: ${data.score}/100`,
  ].join("\n");
}

export type ApprovalRequestData = {
  walletId: string;
  tier: string;
  value: string;
  chainId: string;
  score: number;
};

export function formatApprovalRequest(data: ApprovalRequestData): string {
  const tierDisplay = data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
  const chain = data.chainId.includes("8453") ? "Base" : data.chainId;
  return [
    `🚨 <b>High-Value Transaction — Approval Needed</b>`,
    ``,
    `<b>Agent</b>      ${data.walletId}`,
    `<b>Tier</b>       ${tierDisplay}`,
    `<b>Amount</b>     $${data.value} on ${chain}`,
    `<b>Score</b>      ${data.score}/100`,
    ``,
    `This exceeds auto-approval threshold for this tier.`,
  ].join("\n");
}

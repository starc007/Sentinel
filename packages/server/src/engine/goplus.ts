const RISK_FIELDS = [
  "cybercrime",
  "money_laundering",
  "phishing_activities",
  "darkweb_transactions",
  "stealing_attack",
  "blackmail_activities",
  "sanctioned",
  "malicious_mining_activities",
  "mixer_usage",
  "honeypot_related_address",
  "financial_crime",
] as const;

export type GoPlusResult = {
  flaggedCount: number;
  flaggedAddresses: string[];
};

export async function checkAddresses(
  addresses: string[]
): Promise<GoPlusResult> {
  const flagged: string[] = [];

  for (const address of addresses) {
    try {
      const res = await fetch(
        `https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=8453`,
        { signal: AbortSignal.timeout(3000) }
      );

      if (!res.ok) continue;

      const body = (await res.json()) as {
        code: number;
        result: Record<string, string>;
      };

      if (body.code !== 1 || !body.result) continue;

      const isFlagged = RISK_FIELDS.some(
        (field) => body.result[field] === "1"
      );

      if (isFlagged) flagged.push(address);
    } catch {
      continue;
    }
  }

  return { flaggedCount: flagged.length, flaggedAddresses: flagged };
}

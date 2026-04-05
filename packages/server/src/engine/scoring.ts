export type ScoreInputs = {
  txCount: number;
  activeDays: number;
  denials30d: number;
  flaggedCounterparties: number;
};

export function computeScore(inputs: ScoreInputs): number {
  let score = 0;
  score += Math.min(inputs.txCount, 50);
  score += Math.min(inputs.activeDays * 5, 30);
  score -= inputs.denials30d * 20;
  score -= inputs.flaggedCounterparties * 50;
  return Math.max(0, score);
}

export type Tier = "new" | "established" | "trusted" | "verified";

export function getTier(score: number): Tier {
  if (score >= 75) return "verified";   // max is 80 — needs near-perfect history
  if (score >= 40) return "trusted";
  if (score >= 15) return "established";
  return "new";
}

const TIER_LIMITS: Record<string, number> = {
  new: 5,
  established: 50,
  trusted: 500,
  verified: 5000,
};

export function getTierLimit(tier: string): number {
  return TIER_LIMITS[tier] ?? TIER_LIMITS.new;
}

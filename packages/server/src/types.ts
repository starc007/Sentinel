export type Bindings = {
  KV: KVNamespace;
  TELEGRAM_BOT: Fetcher;
  SENTINEL_SECRET: string;
  ALLIUM_API_KEY: string;
  SENTINEL_KEY: string;
  X402_RECEIVE_ADDRESS: string;
};

export type ReputationScore = {
  wallet: string;
  score: number;
  tier: "new" | "established" | "trusted" | "verified";
  spend_limit: number;
  today_spent: number;
  breakdown: {
    tx_count: number;
    active_days: number;
    policy_denials_30d: number;
    flagged_counterparties: number;
  };
  computed_at: string;
};

export type AuditEvent = {
  timestamp: string;
  wallet_id: string;
  action: "allow" | "deny";
  reason?: string;
  tx_value: string;
  chain_id: string;
};

export type PendingTx = {
  id: string;
  wallet_id: string;
  value: string;
  chain_id: string;
  raw_hex: string;
  reason: string;
  tier: string;
  score: number;
  status: "pending" | "approved" | "rejected";
  token?: string;
  created_at: string;
  telegram_chat_id?: string;
  telegram_message_id?: number;
};

export const TIER_LIMITS: Record<string, number> = {
  new: 5,
  established: 50,
  trusted: 500,
  verified: 5000,
};

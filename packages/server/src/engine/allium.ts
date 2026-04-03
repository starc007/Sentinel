export type WalletHistory = {
  txCount: number;
  activeDays: number;
  firstSeen: string | null;
  counterparties: string[];
};

export async function fetchWalletHistory(
  wallet: string,
  apiKey: string
): Promise<WalletHistory> {
  try {
    const url = `https://api.allium.so/api/v1/explorer/transactions/wallet/${wallet}?chain=base`;
    const res = await fetch(url, {
      headers: { "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      console.error(`Allium API error: ${res.status} ${res.statusText}`);
      return { txCount: 0, activeDays: 0, firstSeen: null, counterparties: [] };
    }

    const body = (await res.json()) as {
      data: Array<{
        hash: string;
        from_address: string;
        to_address: string;
        block_timestamp: string;
      }>;
    };

    const txs = body.data ?? [];
    const uniqueDays = new Set(
      txs.map((tx) => tx.block_timestamp.slice(0, 10))
    );
    const uniqueCounterparties = [
      ...new Set(txs.map((tx) => tx.to_address).filter(Boolean)),
    ];
    const firstSeen =
      txs.length > 0
        ? txs.reduce((min, tx) =>
            tx.block_timestamp < min ? tx.block_timestamp : min,
          txs[0].block_timestamp)
        : null;

    return {
      txCount: txs.length,
      activeDays: uniqueDays.size,
      firstSeen,
      counterparties: uniqueCounterparties,
    };
  } catch (e) {
    console.error("Allium fetch failed:", e);
    return { txCount: 0, activeDays: 0, firstSeen: null, counterparties: [] };
  }
}

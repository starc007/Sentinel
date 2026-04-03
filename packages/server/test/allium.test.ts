import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchWalletHistory, type WalletHistory } from "../src/engine/allium";

describe("fetchWalletHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Allium response into WalletHistory", async () => {
    const mockResponse = {
      data: [
        {
          hash: "0xaaa",
          from_address: "0xwallet",
          to_address: "0xrecipient1",
          block_timestamp: "2026-01-01T00:00:00Z",
        },
        {
          hash: "0xbbb",
          from_address: "0xwallet",
          to_address: "0xrecipient2",
          block_timestamp: "2026-01-01T00:00:00Z",
        },
        {
          hash: "0xccc",
          from_address: "0xwallet",
          to_address: "0xrecipient1",
          block_timestamp: "2026-01-15T00:00:00Z",
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const result = await fetchWalletHistory("0xwallet", "test-key");

    expect(result.txCount).toBe(3);
    expect(result.activeDays).toBe(2);
    expect(result.counterparties).toEqual(["0xrecipient1", "0xrecipient2"]);
  });

  it("returns empty history on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const result = await fetchWalletHistory("0xwallet", "test-key");

    expect(result.txCount).toBe(0);
    expect(result.activeDays).toBe(0);
    expect(result.counterparties).toEqual([]);
  });
});

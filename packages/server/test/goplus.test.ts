import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkAddresses } from "../src/engine/goplus";

describe("checkAddresses", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns flagged addresses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("0xbad")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                code: 1,
                result: {
                  cybercrime: "0",
                  money_laundering: "1",
                  phishing_activities: "0",
                  darkweb_transactions: "0",
                  stealing_attack: "0",
                  blackmail_activities: "0",
                  sanctioned: "0",
                  malicious_mining_activities: "0",
                  mixer_usage: "0",
                  honeypot_related_address: "0",
                  financial_crime: "0",
                  fake_kyc: "0",
                  blacklist_doubt: "0",
                  number_of_malicious_contracts_created: "0",
                  data_source: "GoPlus",
                },
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              code: 1,
              result: {
                cybercrime: "0",
                money_laundering: "0",
                phishing_activities: "0",
                darkweb_transactions: "0",
                stealing_attack: "0",
                blackmail_activities: "0",
                sanctioned: "0",
                malicious_mining_activities: "0",
                mixer_usage: "0",
                honeypot_related_address: "0",
                financial_crime: "0",
                fake_kyc: "0",
                blacklist_doubt: "0",
                number_of_malicious_contracts_created: "0",
                data_source: "GoPlus",
              },
            }),
        });
      })
    );

    const result = await checkAddresses(["0xgood", "0xbad"]);
    expect(result.flaggedCount).toBe(1);
    expect(result.flaggedAddresses).toEqual(["0xbad"]);
  });

  it("returns 0 flagged on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      })
    );

    const result = await checkAddresses(["0xabc"]);
    expect(result.flaggedCount).toBe(0);
    expect(result.flaggedAddresses).toEqual([]);
  });
});

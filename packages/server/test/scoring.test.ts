import { describe, it, expect } from "vitest";
import { computeScore, getTier, getTierLimit } from "../src/engine/scoring";

describe("computeScore", () => {
  it("returns 0 for a brand new wallet with no history", () => {
    const score = computeScore({
      txCount: 0,
      activeDays: 0,
      denials30d: 0,
      flaggedCounterparties: 0,
    });
    expect(score).toBe(0);
  });

  it("caps tx_count contribution at 50", () => {
    const score = computeScore({
      txCount: 200,
      activeDays: 0,
      denials30d: 0,
      flaggedCounterparties: 0,
    });
    expect(score).toBe(50);
  });

  it("caps active_days contribution at 30", () => {
    const score = computeScore({
      txCount: 0,
      activeDays: 100,
      denials30d: 0,
      flaggedCounterparties: 0,
    });
    expect(score).toBe(30);
  });

  it("subtracts 20 per denial", () => {
    const score = computeScore({
      txCount: 50,
      activeDays: 6,
      denials30d: 2,
      flaggedCounterparties: 0,
    });
    // 50 + 30 - 40 = 40
    expect(score).toBe(40);
  });

  it("subtracts 50 per flagged counterparty", () => {
    const score = computeScore({
      txCount: 50,
      activeDays: 6,
      denials30d: 0,
      flaggedCounterparties: 1,
    });
    // 50 + 30 - 50 = 30
    expect(score).toBe(30);
  });

  it("floors at 0", () => {
    const score = computeScore({
      txCount: 1,
      activeDays: 0,
      denials30d: 5,
      flaggedCounterparties: 0,
    });
    // 1 + 0 - 100 = -99 → 0
    expect(score).toBe(0);
  });

  it("computes a realistic mid-tier score", () => {
    const score = computeScore({
      txCount: 30,
      activeDays: 10,
      denials30d: 1,
      flaggedCounterparties: 0,
    });
    // 30 + 50 - 20 = 60
    expect(score).toBe(60);
  });
});

describe("getTier", () => {
  it("returns 'new' for 0-20", () => {
    expect(getTier(0)).toBe("new");
    expect(getTier(20)).toBe("new");
  });

  it("returns 'established' for 21-50", () => {
    expect(getTier(21)).toBe("established");
    expect(getTier(50)).toBe("established");
  });

  it("returns 'trusted' for 51-100", () => {
    expect(getTier(51)).toBe("trusted");
    expect(getTier(100)).toBe("trusted");
  });

  it("returns 'verified' for 101+", () => {
    expect(getTier(101)).toBe("verified");
    expect(getTier(999)).toBe("verified");
  });
});

describe("getTierLimit", () => {
  it("returns correct daily limits", () => {
    expect(getTierLimit("new")).toBe(5);
    expect(getTierLimit("established")).toBe(50);
    expect(getTierLimit("trusted")).toBe(500);
    expect(getTierLimit("verified")).toBe(5000);
  });

  it("defaults to 'new' limit for unknown tier", () => {
    expect(getTierLimit("unknown")).toBe(5);
  });
});

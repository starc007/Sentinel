import { describe, it, expect, vi, afterEach } from "vitest";
import { createApprovalToken, verifyApprovalToken } from "../src/lib/hmac";

const SECRET = "test-secret-key";

describe("HMAC approval tokens", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates and verifies a valid token", async () => {
    const token = await createApprovalToken("0xtxhash", SECRET, 600);
    const result = await verifyApprovalToken(token, SECRET);
    expect(result.valid).toBe(true);
  });

  it("rejects an expired token", async () => {
    const token = await createApprovalToken("0xtxhash", SECRET, -1);
    const result = await verifyApprovalToken(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("rejects a tampered token", async () => {
    const token = await createApprovalToken("0xtxhash", SECRET, 600);
    const tampered = token.replace(/.$/, "x");
    const result = await verifyApprovalToken(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects a malformed token", async () => {
    const result = await verifyApprovalToken("not-a-token", SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed");
  });
});

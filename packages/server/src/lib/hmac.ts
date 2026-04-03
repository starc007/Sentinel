async function hmacSign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createApprovalToken(
  txId: string,
  secret: string,
  ttlSeconds: number = 600
): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${txId}:${expiry}`;
  const sig = await hmacSign(payload, secret);
  return `${txId}:${expiry}:${sig}`;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: "expired" | "invalid_signature" | "malformed" };

export async function verifyApprovalToken(
  token: string,
  secret: string
): Promise<VerifyResult> {
  const parts = token.split(":");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };

  const [txId, expiryStr, sig] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry)) return { valid: false, reason: "malformed" };

  if (Date.now() / 1000 > expiry) return { valid: false, reason: "expired" };

  const expected = await hmacSign(`${txId}:${expiryStr}`, secret);
  if (sig !== expected) return { valid: false, reason: "invalid_signature" };

  return { valid: true };
}

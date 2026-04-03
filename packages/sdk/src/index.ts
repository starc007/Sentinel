export type SignWithApprovalOpts = {
  inboxUrl: string;
  sentinelKey: string;
  pollInterval?: number;
  maxWaitMs?: number;
};

export async function signWithApproval<T>(
  signFn: () => Promise<T>,
  opts: SignWithApprovalOpts
): Promise<T> {
  try {
    return await signFn();
  } catch (e: any) {
    const msg = e?.message ?? "";

    // Extract queue ID from denial reason
    const match = msg.match(/queued:([a-f0-9-]+)/);
    if (!match) throw e;

    const queueId = match[1];
    const pollInterval = opts.pollInterval ?? 3000;
    const maxWait = opts.maxWaitMs ?? 600_000;
    const deadline = Date.now() + maxWait;

    // Poll until human approves or rejects
    while (Date.now() < deadline) {
      await sleep(pollInterval);

      const res = await fetch(`${opts.inboxUrl}/status/${queueId}`, {
        headers: { "X-Sentinel-Key": opts.sentinelKey },
      });
      const data = (await res.json()) as { status: string };

      if (data.status === "rejected") {
        throw new Error("Transaction rejected by human");
      }

      if (data.status === "approved") {
        // Approval is stored server-side. Just retry sign() —
        // the policy will check the server and see the approval.
        return await signFn();
      }
    }

    throw new Error("Approval timeout — no response within deadline");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SignWithApprovalOpts = {
  inboxUrl: string;
  pollInterval?: number;
  maxWaitMs?: number;
};

export async function signWithApproval<T>(
  signFn: (opts?: { metadata?: Record<string, string> }) => Promise<T>,
  opts: SignWithApprovalOpts
): Promise<T> {
  try {
    return await signFn();
  } catch (e: any) {
    const msg = e?.message ?? "";

    const match = msg.match(/queued:([a-f0-9-]+)/);
    if (!match) throw e;

    const queueId = match[1];
    const pollInterval = opts.pollInterval ?? 3000;
    const maxWait = opts.maxWaitMs ?? 600_000;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      await sleep(pollInterval);

      const res = await fetch(`${opts.inboxUrl}/status/${queueId}`);
      const data = (await res.json()) as {
        status: string;
        token?: string;
      };

      if (data.status === "rejected") {
        throw new Error("Transaction rejected by human");
      }

      if (data.status === "approved" && data.token) {
        return await signFn({
          metadata: { inbox_approval_token: data.token },
        });
      }
    }

    throw new Error("Approval timeout — no response within deadline");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

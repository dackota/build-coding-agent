export type SendOptions = { baseUrl: string; namespace: string; agent: string; text: string; timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 180_000;
const USER_ID = "cli@build-coding-agent";

type Part = { text?: string };
type Rpc = {
  result?: { task?: { artifacts?: { parts?: Part[] }[] }; message?: { parts?: Part[] } };
  error?: { message?: string };
};

/** One JSON-RPC SendMessage to the kagent controller's agent endpoint; returns the reply text. */
export async function sendMessage(opts: SendOptions): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/agents/${opts.namespace}/${opts.agent}`, {
    method: "POST",
    headers: { "content-type": "application/json", "A2A-Version": "1.0", "X-User-Id": USER_ID },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: opts.text }] } },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`controller answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as Rpc;
  if (body.error) throw new Error(`controller error: ${body.error.message ?? JSON.stringify(body.error)}`);
  const parts = [
    ...(body.result?.task?.artifacts ?? []).flatMap((a) => a.parts ?? []),
    ...(body.result?.message?.parts ?? []),
  ];
  return parts.map((p) => p.text ?? "").join("");
}

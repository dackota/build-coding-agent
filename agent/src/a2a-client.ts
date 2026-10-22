import { HITL_EXTENSION_URI, type Question } from "./hitl.ts";

export type SendOptions = {
  baseUrl: string;
  namespace: string;
  agent: string;
  text: string;
  timeoutMs?: number;
  /** Files sent with the message, each as a raw part named by its workspace path. */
  files?: { name: string; content: Buffer }[];
  /** Continues a session: a new turn (a new task) on this context. */
  contextId?: string;
  /** Answers the pause of an earlier turn: same task and context, with an ask_user_response. */
  reply?: { taskId: string; contextId: string; requestId: string; answers: string[][] };
};

export type Turn = {
  /** "completed", "input-required", "failed", ... or "message" when the agent replied without a task. */
  state: string;
  taskId: string;
  contextId: string;
  text: string;
  pause?: { requestId: string; questions: Question[] };
};

const DEFAULT_TIMEOUT_MS = 180_000;
const USER_ID = "cli@build-coding-agent";

type Part = { text?: string };
type WireMessage = { parts?: Part[]; metadata?: Record<string, unknown>; extensions?: string[] };
type WireTask = { id?: string; contextId?: string; status?: { state?: string; message?: WireMessage }; artifacts?: { parts?: Part[] }[] };
type Rpc = { result?: { task?: WireTask; message?: WireMessage & { contextId?: string } }; error?: { message?: string } };

const textOf = (parts: Part[] = []) => parts.map((p) => p.text ?? "").join("");
const stateName = (raw: string | undefined) => (raw ?? "").replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-");

/** One JSON-RPC SendMessage to the kagent controller's agent endpoint. The HITL extension header goes on every call. */
export async function sendTurn(opts: SendOptions): Promise<Turn> {
  const message: Record<string, unknown> = {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [
      ...(opts.files ?? []).map((f) => ({ raw: f.content.toString("base64"), filename: f.name, mediaType: "text/plain" })),
      { text: opts.text },
    ],
  };
  if (opts.contextId) message.contextId = opts.contextId;
  if (opts.reply) {
    message.taskId = opts.reply.taskId;
    message.contextId = opts.reply.contextId;
    message.extensions = [HITL_EXTENSION_URI];
    message.metadata = {
      [HITL_EXTENSION_URI]: { type: "ask_user_response", id: opts.reply.requestId, answers: opts.reply.answers.map((answer) => ({ answer })) },
    };
  }
  const res = await fetch(`${opts.baseUrl}/agents/${opts.namespace}/${opts.agent}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "A2A-Version": "1.0",
      "A2A-Extensions": HITL_EXTENSION_URI,
      "X-User-Id": USER_ID,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message } }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`controller answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as Rpc;
  if (body.error) throw new Error(`controller error: ${body.error.message ?? JSON.stringify(body.error)}`);

  const task = body.result?.task;
  if (!task) {
    const m = body.result?.message;
    return { state: "message", taskId: "", contextId: m?.contextId ?? "", text: textOf(m?.parts) };
  }
  const state = stateName(task.status?.state);
  // One line per artifact: the reply, then the diff when the turn changed files.
  const artifactText = (task.artifacts ?? []).map((a) => textOf(a.parts)).join("\n");
  const statusMessage = task.status?.message;
  const turn: Turn = {
    state,
    taskId: task.id ?? "",
    contextId: task.contextId ?? "",
    text: artifactText || textOf(statusMessage?.parts),
  };
  const payload = statusMessage?.metadata?.[HITL_EXTENSION_URI] as { type?: string; id?: string; questions?: Question[] } | undefined;
  if (state === "input-required" && payload?.type === "ask_user_request" && payload.id) {
    turn.pause = { requestId: payload.id, questions: payload.questions ?? [] };
  }
  return turn;
}

/** One SendMessage, returning the reply text only. */
export async function sendMessage(opts: SendOptions): Promise<string> {
  return (await sendTurn(opts)).text;
}

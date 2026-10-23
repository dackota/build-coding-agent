import { type ApprovalDecision, HITL_EXTENSION_URI, type Question } from "./hitl.ts";
import { readStreamEvent, type StreamEvent } from "./stream-events.ts";

export type { StreamEvent };

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
  /** Decides a tool approval pause: the same decision for each pending tool id. */
  approval?: { taskId: string; contextId: string; ids: string[]; decision: ApprovalDecision };
  /** Streams the turn (SendStreamingMessage): called with each text delta and tool call as it happens. */
  onEvent?: (event: StreamEvent) => void;
  /** Called with the task and context ids as soon as the stream names them (Ctrl-C needs them to cancel). */
  onIds?: (ids: { taskId: string; contextId: string }) => void;
  /** Aborts the request. */
  signal?: AbortSignal;
};

export type ApprovalTool = { id: string; name: string; args: Record<string, unknown> };

export type Turn = {
  /** "completed", "input-required", "failed", ... or "message" when the agent replied without a task. */
  state: string;
  taskId: string;
  contextId: string;
  text: string;
  /** The text of each artifact, in order: the reply, then the diff when the turn changed files. */
  artifactTexts?: string[];
  pause?: { requestId: string; questions: Question[] };
  /** A tool approval pause: the tool calls waiting for a decision. */
  approval?: { hint: string; tools: ApprovalTool[] };
};

/** kagent's ToolApproval for one decision; "approve for this session" adds scope "session". */
function wireApproval(id: string, decision: ApprovalDecision): Record<string, unknown> {
  if (decision.type === "deny") return { id, approved: false, rejection_reason: decision.reason };
  return decision.type === "approve_session" ? { id, approved: true, scope: "session" } : { id, approved: true };
}

const DEFAULT_TIMEOUT_MS = 180_000;
const CANCEL_TIMEOUT_MS = 10_000;
/** Sessions belong to a user: KAGENT_USER_ID lets the CLI act as the user the kagent UI signs in as. */
const USER_ID = process.env.KAGENT_USER_ID ?? "cli@build-coding-agent";

type Part = { text?: string };
type StreamResult = Rpc["result"] & {
  statusUpdate?: { taskId?: string; contextId?: string; status?: WireTask["status"] };
  artifactUpdate?: { taskId?: string; contextId?: string; artifact?: { parts?: Part[] }; append?: boolean };
};
type WireMessage = { parts?: Part[]; metadata?: Record<string, unknown>; extensions?: string[] };
type WireTask = { id?: string; contextId?: string; status?: { state?: string; message?: WireMessage }; artifacts?: { parts?: Part[] }[] };
type Rpc = { result?: { task?: WireTask; message?: WireMessage & { contextId?: string } }; error?: { message?: string } };

const textOf = (parts: Part[] = []) => parts.map((p) => p.text ?? "").join("");
const stateName = (raw: string | undefined) => (raw ?? "").replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-");

const HEADERS = {
  "content-type": "application/json",
  "A2A-Version": "1.0",
  "A2A-Extensions": HITL_EXTENSION_URI,
  "X-User-Id": USER_ID,
};

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
  } else if (opts.approval) {
    message.taskId = opts.approval.taskId;
    message.contextId = opts.approval.contextId;
    message.extensions = [HITL_EXTENSION_URI];
    message.metadata = {
      [HITL_EXTENSION_URI]: { type: "tool_approval_response", approvals: opts.approval.ids.map((id) => wireApproval(id, opts.approval!.decision)) },
    };
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const res = await fetch(`${opts.baseUrl}/agents/${opts.namespace}/${opts.agent}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: opts.onEvent ? "SendStreamingMessage" : "SendMessage", params: { message } }),
    signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
  });
  if (!res.ok) throw new Error(`controller answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (opts.onEvent) return readStream(res, opts);
  const body = (await res.json()) as Rpc;
  if (body.error) throw new Error(`controller error: ${body.error.message ?? JSON.stringify(body.error)}`);

  return turnFromResult(body.result);
}

function turnFromResult(result: Rpc["result"]): Turn {
  const task = result?.task;
  if (!task) {
    const m = result?.message;
    return { state: "message", taskId: "", contextId: m?.contextId ?? "", text: textOf(m?.parts) };
  }
  const state = stateName(task.status?.state);
  // One line per artifact: the reply, then the diff when the turn changed files.
  const artifactTexts = (task.artifacts ?? []).map((a) => textOf(a.parts));
  const artifactText = artifactTexts.join("\n");
  const statusMessage = task.status?.message;
  const turn: Turn = {
    state,
    taskId: task.id ?? "",
    contextId: task.contextId ?? "",
    text: artifactText || textOf(statusMessage?.parts),
    artifactTexts,
  };
  const payload = statusMessage?.metadata?.[HITL_EXTENSION_URI] as
    | { type?: string; id?: string; questions?: Question[]; hint?: string; tools?: ApprovalTool[] }
    | undefined;
  if (state === "input-required" && payload?.type === "ask_user_request" && payload.id) {
    turn.pause = { requestId: payload.id, questions: payload.questions ?? [] };
  }
  if (state === "input-required" && payload?.type === "tool_approval_request" && Array.isArray(payload.tools)) {
    turn.approval = { hint: payload.hint ?? "", tools: payload.tools.map(({ id, name, args }) => ({ id, name, args: args ?? {} })) };
  }
  return turn;
}

/** One SendMessage, returning the reply text only. */
export async function sendMessage(opts: SendOptions): Promise<string> {
  return (await sendTurn(opts)).text;
}

/** Each `data:` line of a server-sent event stream, as parsed JSON-RPC responses. */
async function* sseResults(res: Response): AsyncGenerator<Rpc & { result?: StreamResult }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const data = buffer.slice(0, end).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      buffer = buffer.slice(end + 2);
      if (data) yield JSON.parse(data) as Rpc & { result?: StreamResult };
    }
  }
}

/** Reads a SendStreamingMessage reply: progress events go to onEvent, the rest builds the final Turn. */
async function readStream(res: Response, opts: SendOptions): Promise<Turn> {
  let turn: Turn = { state: "working", taskId: "", contextId: "", text: "" };
  let statusMessage: WireMessage | undefined;
  let snapshot: Turn | undefined;
  const artifacts: string[] = [];
  const noteIds = (taskId?: string, contextId?: string) => {
    const next = { taskId: taskId || turn.taskId, contextId: contextId || turn.contextId };
    if (next.taskId !== turn.taskId || next.contextId !== turn.contextId) {
      turn = { ...turn, ...next };
      if (next.taskId && next.contextId) opts.onIds?.(next);
    }
  };
  for await (const body of sseResults(res)) {
    if (body.error) throw new Error(`controller error: ${body.error.message ?? JSON.stringify(body.error)}`);
    const r = body.result;
    if (r?.task) {
      noteIds(r.task.id, r.task.contextId);
      // A snapshot supersedes the updates before it (the controller ends a stream with one).
      snapshot = turnFromResult(r);
      statusMessage = undefined;
      turn = { ...turn, state: snapshot.state };
    } else if (r?.message) {
      noteIds(undefined, r.message.contextId);
      turn = { ...turn, state: "message", text: textOf(r.message.parts) };
    } else if (r?.statusUpdate) {
      const u = r.statusUpdate;
      noteIds(u.taskId, u.contextId);
      turn = { ...turn, state: stateName(u.status?.state) };
      statusMessage = u.status?.message;
      snapshot = undefined;
      const event = readStreamEvent(statusMessage?.metadata);
      if (event) opts.onEvent?.(event);
    } else if (r?.artifactUpdate) {
      const u = r.artifactUpdate;
      noteIds(u.taskId, u.contextId);
      artifacts.push(textOf(u.artifact?.parts));
    }
  }
  if (snapshot) {
    const hasArtifacts = (snapshot.artifactTexts ?? []).length > 0;
    return hasArtifacts || artifacts.length === 0 ? snapshot : { ...snapshot, text: artifacts.join("\n"), artifactTexts: artifacts };
  }
  const final = turnFromResult({ task: { id: turn.taskId, contextId: turn.contextId, status: { state: turn.state, message: statusMessage } } });
  return { ...final, state: turn.state, text: artifacts.length > 0 ? artifacts.join("\n") : final.text, artifactTexts: artifacts };
}

/** CancelTask: stops the running turn. The session keeps the steps that finished. */
export async function cancelTask(opts: { baseUrl: string; namespace: string; agent: string; taskId: string; timeoutMs?: number }): Promise<void> {
  const res = await fetch(`${opts.baseUrl}/agents/${opts.namespace}/${opts.agent}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "CancelTask", params: { id: opts.taskId } }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? CANCEL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`controller answered HTTP ${res.status} to CancelTask: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as Rpc;
  if (body.error) throw new Error(`CancelTask: ${body.error.message ?? JSON.stringify(body.error)}`);
}

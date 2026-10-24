// The byo contract's rules (docs/byo-contract.md) as pure checks over what the checker saw
// while it played kagent's side against the image under test.

export type RuleResult = { rule: number; name: string; status: "pass" | "fail" | "skip"; detail: string };

export type ControllerCall = { method: string; authorization: string | undefined; sessionId: string | undefined };
export type ModelRequest = { path: string; authorization: string | undefined; body: string };
export type SendOutcome =
  | { ok: true; kind: "task" | "message"; completed: boolean; reply: string }
  | { ok: false; error: string };

export type Observations = {
  /** Did /readyz ever answer 200? */
  readyz: "answered" | "never";
  /**
   * The gRPC port on the pod address, probed the moment /readyz first answered: open then,
   * opened only later, or never open. Undefined when /readyz never answered.
   */
  grpcOpenAtReadyz: true | "late" | "never" | undefined;
  send: SendOutcome | undefined;
  expectedReply: string;
  controllerCalls: ControllerCall[];
  /** settleTask calls the controller stand-in refused. */
  refusedSettles: number;
  modelRequests: ModelRequest[];
  sessionId: string;
  apiKey: string;
  instruction: string;
};

export const PLACEHOLDER_BEARER = "Bearer placeholder";
const RULE_NAMES: Record<number, string> = {
  1: "A2A over gRPC",
  2: "Bind 0.0.0.0:80",
  3: "Open the port before /readyz",
  4: "Task store calls to the control-plane URL with the placeholder bearer",
  5: "Settle only at real boundaries",
  6: "Read the runtime config",
  7: "Run subagents and MCP tools itself",
  8: "Send HITL pauses",
  9: "Honor the egress trust bundle",
};
const NOT_CHECKED: Record<number, string> = {
  7: "not checked: it depends on the tools and subagents your values file lists; test it with your own tool set",
  8: "not checked: it depends on which tools need approval; test it with a write tool",
  9: "not checked: the check has no Substrate egress gateway; test it on a deployed agent",
};

const pass = (rule: number, detail: string): RuleResult => ({ rule, name: RULE_NAMES[rule]!, status: "pass", detail });
const fail = (rule: number, detail: string): RuleResult => ({ rule, name: RULE_NAMES[rule]!, status: "fail", detail });
const skip = (rule: number, detail: string): RuleResult => ({ rule, name: RULE_NAMES[rule]!, status: "skip", detail });

function ruleOne(o: Observations): RuleResult {
  const s = o.send;
  if (!s) return fail(1, "no message was sent");
  if (!s.ok) return fail(1, `SendMessage over gRPC failed: ${s.error}`);
  if (s.kind !== "task") return fail(1, "SendMessage answered with a bare message; reply with a task, which the controller can keep, publish and suspend on");
  if (!s.completed) return fail(1, "the task did not end COMPLETED");
  if (s.reply !== o.expectedReply) return fail(1, `the task's reply was ${JSON.stringify(s.reply)}, want the model's reply ${JSON.stringify(o.expectedReply)}`);
  return pass(1, "a message started a task that ended COMPLETED with the model's reply");
}

function ruleFour(o: Observations): RuleResult {
  if (o.controllerCalls.length === 0) return fail(4, "the image never called the task store at runtime.control_plane_url");
  const wrongBearer = o.controllerCalls.find((c) => c.authorization !== PLACEHOLDER_BEARER);
  if (wrongBearer) return fail(4, `${wrongBearer.method} carried authorization ${JSON.stringify(wrongBearer.authorization)}, want "${PLACEHOLDER_BEARER}"`);
  const wrongSession = o.controllerCalls.find((c) => c.sessionId !== o.sessionId);
  if (wrongSession) return fail(4, `${wrongSession.method} used session id ${JSON.stringify(wrongSession.sessionId)}, want ${o.sessionId} from /run/kagent/identity/name`);
  return pass(4, `${o.controllerCalls.length} task store calls, all with the placeholder bearer and the identity file's session`);
}

function ruleFive(o: Observations): RuleResult {
  const settles = o.controllerCalls.filter((c) => c.method === "settleTask").length;
  if (o.refusedSettles > 0) return fail(5, `the controller refused ${o.refusedSettles} settleTask call(s): settle only when the task reaches a boundary`);
  if (settles === 0) return fail(5, "settleTask was never called when the task ended");
  if (settles > 1) return fail(5, `settleTask was called ${settles} times for one task; call it once, at the boundary`);
  if (o.controllerCalls.at(-1)?.method !== "settleTask") return fail(5, "the task was saved again after it was settled");
  return pass(5, "settleTask was called once, after the last save");
}

function ruleSix(o: Observations): RuleResult {
  if (o.modelRequests.length === 0) return fail(6, "the model was never called at agent.model.openai.base_url from the config");
  const bad = o.modelRequests.find((m) => m.authorization !== `Bearer ${o.apiKey}`);
  if (bad) return fail(6, `the model call carried authorization ${JSON.stringify(bad.authorization)}, want "Bearer ${o.apiKey}" (OPENAI_API_KEY)`);
  if (!o.modelRequests.some((m) => m.body.includes(o.instruction))) return fail(6, "the config's agent.instruction never reached the model");
  return pass(6, "the model call went to the configured base URL with OPENAI_API_KEY as the bearer and the config's instruction");
}

/** Judge each rule from the observations; rules the check cannot reach are skipped with the reason. */
export function evaluate(o: Observations): RuleResult[] {
  const blocked =
    o.readyz === "never"
      ? "not run: /readyz never answered"
      : o.grpcOpenAtReadyz === "never"
        ? "not run: the gRPC port was never open on the pod address (rule 2)"
        : undefined;
  const dependent = (rule: number, judge: (o: Observations) => RuleResult) => (blocked ? skip(rule, blocked) : judge(o));

  const two =
    o.readyz === "never"
      ? skip(2, blocked!)
      : o.grpcOpenAtReadyz === "never"
        ? fail(2, "port 80 refused a connection on the pod address; listen on 0.0.0.0:80, not 127.0.0.1")
        : pass(2, "port 80 accepts connections on the pod address");
  const three =
    o.readyz === "never"
      ? fail(3, "/readyz on port 8081 never answered 200")
      : o.grpcOpenAtReadyz === "late"
        ? fail(3, "/readyz answered 200 before the gRPC port was open; open the port first")
        : o.grpcOpenAtReadyz === "never"
          ? skip(3, blocked!)
          : pass(3, "the gRPC port was open when /readyz first answered");
  return [
    dependent(1, ruleOne),
    two,
    three,
    dependent(4, ruleFour),
    dependent(5, ruleFive),
    dependent(6, ruleSix),
    skip(7, NOT_CHECKED[7]!),
    skip(8, NOT_CHECKED[8]!),
    skip(9, NOT_CHECKED[9]!),
  ];
}

const LABEL = { pass: "PASS", fail: "FAIL", skip: "skip" } as const;

/** One line per rule (PASS, FAIL or skip), then a verdict line. */
export function formatReport(results: RuleResult[]): string {
  const lines = results.map((r) => `${LABEL[r.status]}  ${r.rule}  ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => r.status === "fail");
  const verdict = failed.length === 0 ? "byo-check: PASSED" : `byo-check: FAILED (rule ${failed.map((r) => r.rule).join(", ")})`;
  return [...lines, verdict, ""].join("\n");
}

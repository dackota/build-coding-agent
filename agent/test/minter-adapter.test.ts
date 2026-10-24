// The minter's Kubernetes adapter against a fake client: it reads the registrations, the key
// Secrets and agentgateway's API-key ConfigMap, and applies exactly what plan() returns.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type MinterConfig, readState, runOnce } from "../src/minter/adapter.ts";
import { type Change, plan } from "../src/minter/plan.ts";
import { FakeKube, type Write } from "./fake-kube.ts";

const CONFIG: MinterConfig = {
  teams: ["platform", "payments"],
  apiKeys: { namespace: "agentgateway-system", name: "agent-api-keys" },
  mcp: { namespace: "agentgateway-system", backends: ["github-mcp", "demo-mcp"] },
};
const REGISTRATION = { "agents.build-coding-agent.dev/registration": "true" };
const KEY_LABELS = (agent: string) => ({ "app.kubernetes.io/managed-by": "minter", "agents.build-coding-agent.dev/agent-key": "true", "agents.build-coding-agent.dev/agent": agent });
const POLICY_LABELS = (team: string, agent: string) => ({
  "app.kubernetes.io/managed-by": "minter",
  "agents.build-coding-agent.dev/mcp-tools": "true",
  "agents.build-coding-agent.dev/team": team,
  "agents.build-coding-agent.dev/agent": agent,
});
const TARGETS = [
  { group: "agentgateway.dev", kind: "AgentgatewayBackend", name: "github-mcp" },
  { group: "agentgateway.dev", kind: "AgentgatewayBackend", name: "demo-mcp" },
];
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function keyMaker(): () => string {
  let n = 0;
  return () => `fake-key-${++n}`;
}

function register(kube: FakeKube, team: string, agent: string, dataTeam = team, mcpTools = '["issue_read"]'): void {
  kube.seedConfigMap(`team-${team}`, `${agent}-registration`, REGISTRATION, { team: dataTeam, agent, owner: "o", runtime: "stock", model: "glm-5.3-flash", tokenCap: "1000", mcpTools });
}

function cluster(): FakeKube {
  const kube = new FakeKube();
  kube.seedConfigMap("agentgateway-system", "agent-api-keys", { "agents.build-coding-agent.dev/api-keys": "true" }, {});
  return kube;
}

/** The writes a change list should cause: Secrets one by one, hash entries in one patch. */
function expectedWrites(changes: readonly Change[]): Write[] {
  const patch: Record<string, string | null> = {};
  const secretWrites: Write[] = [];
  for (const c of changes) {
    if (c.kind === "put-secret") secretWrites.push({ op: "put-secret", namespace: c.namespace, name: c.name });
    if (c.kind === "delete-secret") secretWrites.push({ op: "delete-secret", namespace: c.namespace, name: c.name });
    if (c.kind === "put-policy") secretWrites.push({ op: "put-policy", namespace: "agentgateway-system", name: c.name });
    if (c.kind === "delete-policy") secretWrites.push({ op: "delete-policy", namespace: "agentgateway-system", name: c.name });
    if (c.kind === "set-hash") patch[c.entry] = JSON.stringify({ keyHash: c.keyHash, metadata: { team: c.team, agent: c.agent } });
    if (c.kind === "delete-hash") patch[c.entry] = null;
  }
  const patches: Write[] = Object.keys(patch).length > 0 ? [{ op: "patch-configmap", namespace: "agentgateway-system", name: "agent-api-keys", data: patch }] : [];
  return [...secretWrites, ...patches];
}

const sortWrites = (ws: Write[]) => [...ws].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe("minter adapter", () => {
  it("reads registrations from each team namespace and applies exactly the changes plan returns", async () => {
    const kube = cluster();
    register(kube, "platform", "hello-agent");
    register(kube, "payments", "pay-bot");
    // A stale key whose registration is gone, and a hash for it.
    kube.seedSecret("team-platform", "old-agent-key", KEY_LABELS("old"), { "agents.build-coding-agent.dev/key-hash": sha("old") }, { OPENAI_API_KEY: "old" });
    await kube.patchConfigMapData("agentgateway-system", "agent-api-keys", { "platform.old": JSON.stringify({ keyHash: sha("old"), metadata: { team: "platform", agent: "old" } }) });
    kube.writes.length = 0;

    const state = await readState(kube, CONFIG);
    const expected = plan(state.registrations, CONFIG.teams, state.current, keyMaker());
    const applied = await runOnce(kube, CONFIG, keyMaker());

    expect(applied).toEqual(expected);
    expect(sortWrites(kube.writes)).toEqual(sortWrites(expectedWrites(expected)));

    for (const [team, agent] of [["platform", "hello-agent"], ["payments", "pay-bot"]] as const) {
      const secret = kube.secret(`team-${team}`, `${agent}-agent-key`)!;
      expect(secret, agent).toBeDefined();
      const plaintext = secret.data.OPENAI_API_KEY!;
      expect(secret.labels).toEqual(KEY_LABELS(agent));
      expect(secret.annotations["agents.build-coding-agent.dev/key-hash"]).toBe(sha(plaintext));
      const entry = JSON.parse(kube.configMap("agentgateway-system", "agent-api-keys")!.data[`${team}.${agent}`]!);
      expect(entry).toEqual({ keyHash: sha(plaintext), metadata: { team, agent } });
    }
  });

  it("deletes the Secret, hash and tool policy of a removed registration", async () => {
    const kube = cluster();
    register(kube, "platform", "hello-agent");
    await runOnce(kube, CONFIG, keyMaker());
    expect(kube.policy("agentgateway-system", "mcp-tools.platform.hello-agent")).toBeDefined();
    kube.configMaps.delete("team-platform/hello-agent-registration");

    await runOnce(kube, CONFIG, keyMaker());

    expect(kube.secret("team-platform", "hello-agent-agent-key")).toBeUndefined();
    expect(kube.configMap("agentgateway-system", "agent-api-keys")!.data).toEqual({});
    expect(kube.policy("agentgateway-system", "mcp-tools.platform.hello-agent")).toBeUndefined();
  });

  it("writes one MCP tool policy per registration, naming its team, agent and tools", async () => {
    const kube = cluster();
    register(kube, "platform", "hello-agent", "platform", '["create_branch","push_files","create_pull_request","delete_branch"]');
    register(kube, "payments", "pay-bot", "payments", '["issue_read"]');
    register(kube, "payments", "quiet", "payments", "not json");

    await runOnce(kube, CONFIG, keyMaker());

    expect(kube.policy("agentgateway-system", "mcp-tools.platform.hello-agent")).toEqual({
      name: "mcp-tools.platform.hello-agent",
      labels: POLICY_LABELS("platform", "hello-agent"),
      targetRefs: TARGETS,
      matchExpressions: ['apiKey.team == "platform" && apiKey.agent == "hello-agent" && mcp.tool.name in ["create_branch", "create_pull_request", "delete_branch", "push_files"]'],
    });
    expect(kube.policy("agentgateway-system", "mcp-tools.payments.pay-bot")!.matchExpressions).toEqual([
      'apiKey.team == "payments" && apiKey.agent == "pay-bot" && mcp.tool.name in ["issue_read"]',
    ]);
    // A registration whose tool list cannot be read gets a policy that allows nothing.
    expect(kube.policy("agentgateway-system", "mcp-tools.payments.quiet")!.matchExpressions).toEqual(['apiKey.team == "payments" && apiKey.agent == "quiet" && mcp.tool.name in []']);
  });

  it("rewrites a minter policy someone changed by hand, and leaves policies it does not own alone", async () => {
    const kube = cluster();
    register(kube, "platform", "hello-agent");
    await runOnce(kube, CONFIG, keyMaker());
    kube.seedPolicy("agentgateway-system", { name: "mcp-tools.platform.hello-agent", labels: POLICY_LABELS("platform", "hello-agent"), targetRefs: TARGETS, matchExpressions: ["true"] });
    kube.seedPolicy("agentgateway-system", { name: "mcp-deny-floor", labels: {}, targetRefs: TARGETS, matchExpressions: ["false"] });
    kube.writes.length = 0;

    await runOnce(kube, CONFIG, keyMaker());

    expect(kube.writes).toEqual([{ op: "put-policy", namespace: "agentgateway-system", name: "mcp-tools.platform.hello-agent" }]);
    expect(kube.policy("agentgateway-system", "mcp-tools.platform.hello-agent")!.matchExpressions).toEqual([
      'apiKey.team == "platform" && apiKey.agent == "hello-agent" && mcp.tool.name in ["issue_read"]',
    ]);
    expect(kube.policy("agentgateway-system", "mcp-deny-floor")).toBeDefined();
  });

  it("a second run changes nothing", async () => {
    const kube = cluster();
    register(kube, "platform", "hello-agent");
    register(kube, "payments", "pay-bot");
    await runOnce(kube, CONFIG, keyMaker());
    kube.writes.length = 0;

    expect(await runOnce(kube, CONFIG, keyMaker())).toEqual([]);
    expect(kube.writes).toEqual([]);
  });

  it("skips a registration whose team is not its namespace's team", async () => {
    const kube = cluster();
    register(kube, "platform", "sneaky", "payments");

    const state = await readState(kube, CONFIG);
    expect(state.registrations).toEqual([]);
    expect(state.skipped).toEqual([expect.stringMatching(/team-platform\/sneaky-registration.*payments/)]);
    expect(await runOnce(kube, CONFIG, keyMaker())).toEqual([]);
  });

  it("never lists a namespace outside the team namespaces and agentgateway's", async () => {
    const kube = cluster();
    register(kube, "platform", "hello-agent");
    // A registration-shaped ConfigMap in a namespace that is no team's.
    kube.seedConfigMap("kube-system", "evil-registration", REGISTRATION, { team: "platform", agent: "evil" });

    const state = await readState(kube, CONFIG);
    expect(state.registrations).toEqual([{ team: "platform", agent: "hello-agent", tools: ["issue_read"], tokenCap: 1000 }]);
  });
});

describe("minter adapter: token caps", () => {
  const RATE_LIMIT = { namespace: "agentgateway-system", name: "ratelimit-config" };
  const CAP_CONFIG: MinterConfig = { ...CONFIG, budgets: { platform: 5000 }, rateLimit: RATE_LIMIT };
  const capCluster = (): FakeKube => {
    const kube = cluster();
    kube.seedConfigMap(RATE_LIMIT.namespace, RATE_LIMIT.name, {}, {});
    return kube;
  };
  /** The ratelimit config as the service reads it: domain agw, one descriptor per agent and team. */
  const descriptors = (kube: FakeKube) => (JSON.parse(kube.configMap(RATE_LIMIT.namespace, RATE_LIMIT.name)!.data["config.yaml"] ?? "{}") as { domain?: string; descriptors?: unknown[] });

  it("writes the agent and team caps into the ratelimit config and drops a deleted agent's", async () => {
    const kube = capCluster();
    register(kube, "platform", "hello-agent");
    register(kube, "platform", "docs-agent");
    await runOnce(kube, CAP_CONFIG, keyMaker());

    const month = (n: number) => ({ unit: "month", requests_per_unit: n });
    expect(descriptors(kube)).toEqual({
      domain: "agw",
      descriptors: [
        { key: "agent", value: "platform.docs-agent", rate_limit: month(1000) },
        { key: "agent", value: "platform.hello-agent", rate_limit: month(1000) },
        { key: "team", value: "platform", rate_limit: month(5000) },
      ],
    });

    kube.configMaps.delete("team-platform/docs-agent-registration");
    await runOnce(kube, CAP_CONFIG, keyMaker());
    expect(descriptors(kube).descriptors).toEqual([
      { key: "agent", value: "platform.hello-agent", rate_limit: month(1000) },
      { key: "team", value: "platform", rate_limit: month(5000) },
    ]);
  });

  it("says why a registration of a team with no budget gets nothing", async () => {
    const kube = capCluster();
    register(kube, "payments", "pay-bot");
    const said: string[] = [];

    const changes = await runOnce(kube, CAP_CONFIG, keyMaker(), (why) => said.push(why));

    expect(changes.filter((c) => c.kind !== "set-limit")).toEqual([]);
    expect(kube.secret("team-payments", "pay-bot-agent-key")).toBeUndefined();
    expect(said).toEqual([expect.stringMatching(/team-payments\/pay-bot-registration.*payments.*no budget/)]);
    expect(descriptors(kube).descriptors).toEqual([{ key: "team", value: "platform", rate_limit: { unit: "month", requests_per_unit: 5000 } }]);
  });

  it("says why a registration with no usable tokenCap gets nothing", async () => {
    const kube = capCluster();
    kube.seedConfigMap("team-platform", "odd-registration", REGISTRATION, { team: "platform", agent: "odd", tokenCap: "lots" });
    const said: string[] = [];
    await runOnce(kube, CAP_CONFIG, keyMaker(), (why) => said.push(why));
    expect(kube.secret("team-platform", "odd-agent-key")).toBeUndefined();
    expect(said).toEqual([expect.stringMatching(/team-platform\/odd-registration.*tokenCap/)]);
  });

  it("fails the run, writing nothing, when the ratelimit config is not JSON", async () => {
    const kube = capCluster();
    kube.seedConfigMap(RATE_LIMIT.namespace, RATE_LIMIT.name, {}, { "config.yaml": "domain: [oops" });
    register(kube, "platform", "hello-agent");
    await expect(runOnce(kube, CAP_CONFIG, keyMaker())).rejects.toThrow();
    expect(kube.writes).toEqual([]);
    expect(kube.configMap(RATE_LIMIT.namespace, RATE_LIMIT.name)!.data["config.yaml"]).toBe("domain: [oops");
  });

  it("a second run changes nothing", async () => {
    const kube = capCluster();
    register(kube, "platform", "hello-agent");
    await runOnce(kube, CAP_CONFIG, keyMaker());
    kube.writes.length = 0;
    expect(await runOnce(kube, CAP_CONFIG, keyMaker())).toEqual([]);
    expect(kube.writes).toEqual([]);
  });
});

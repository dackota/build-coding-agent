// The minter's thin Kubernetes side: read the registrations, the key Secrets (metadata only),
// agentgateway's API-key ConfigMap, the minter's MCP tool policies and the token caps; hand
// them to plan(); apply what it returns.
import type { KubeClient, McpPolicy, TargetRef } from "./kube.ts";
import { type Budgets, type Change, type Current, type HashEntry, type KeySecret, type LimitEntry, plan, randomKey, type Registration, teamNamespace, type ToolPolicy } from "./plan.ts";

/**
 * apiKeys: agentgateway's API-key ConfigMap. mcp: where the agents' tool policies go, and the
 * catalog MCP backends they cover. budgets and rateLimit turn on the token caps: the budgets
 * file's amounts, and the ratelimit service's config ConfigMap.
 */
export type MinterConfig = {
  teams: readonly string[];
  apiKeys: { namespace: string; name: string };
  mcp: { namespace: string; backends: readonly string[] };
  budgets?: Budgets;
  rateLimit?: { namespace: string; name: string };
};
export type State = { registrations: Registration[]; current: Current; skipped: string[] };

export const REGISTRATION_SELECTOR = "agents.build-coding-agent.dev/registration=true";
const KEY_LABEL = "agents.build-coding-agent.dev/agent-key";
const AGENT_LABEL = "agents.build-coding-agent.dev/agent";
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const KEY_HASH_ANNOTATION = "agents.build-coding-agent.dev/key-hash";
const KEY_SELECTOR = `${MANAGED_BY_LABEL}=minter,${KEY_LABEL}=true`;
const TEAM_LABEL = "agents.build-coding-agent.dev/team";
const MCP_TOOLS_LABEL = "agents.build-coding-agent.dev/mcp-tools";
const POLICY_SELECTOR = `${MANAGED_BY_LABEL}=minter,${MCP_TOOLS_LABEL}=true`;

const backendRefs = (config: MinterConfig): TargetRef[] => config.mcp.backends.map((name) => ({ group: "agentgateway.dev", kind: "AgentgatewayBackend", name }));

/** The registration's MCP tool names (data mcpTools, a JSON list); anything else reads as none, which hides every tool. */
function parseTools(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** A policy keeps its rule only when it targets exactly the catalog backends with one rule; otherwise plan rewrites it. */
function toToolPolicy(p: McpPolicy, config: MinterConfig): ToolPolicy {
  const isOurShape = JSON.stringify(p.targetRefs) === JSON.stringify(backendRefs(config)) && p.matchExpressions.length === 1;
  return { name: p.name, team: p.labels[TEAM_LABEL] ?? "", agent: p.labels[AGENT_LABEL] ?? "", rule: isOurShape ? p.matchExpressions[0]! : "" };
}
/** The Secret key the agent's ModelConfig reads (apiKeySecretKey). */
export const SECRET_KEY = "OPENAI_API_KEY";

/** One API-key ConfigMap value: agentgateway reads keyHash; CEL reads metadata as apiKey.team and apiKey.agent. */
function parseEntry(entry: string, value: string): HashEntry {
  try {
    const parsed = JSON.parse(value) as { keyHash?: unknown; metadata?: { team?: unknown; agent?: unknown } };
    return {
      entry,
      keyHash: typeof parsed.keyHash === "string" ? parsed.keyHash : "",
      team: typeof parsed.metadata?.team === "string" ? parsed.metadata.team : "",
      agent: typeof parsed.metadata?.agent === "string" ? parsed.metadata.agent : "",
    };
  } catch {
    return { entry, keyHash: "", team: "", agent: "" };
  }
}

/** The ratelimit service's config: one file, domain agw, a month limit per agent ("team.agent") and per team. */
export const RATELIMIT_FILE = "config.yaml";
export const RATELIMIT_DOMAIN = "agw";
const RATELIMIT_UNIT = "month";

/** A config that is not JSON throws: the run fails and nothing is rewritten over it. */
function parseLimits(text: string | undefined): LimitEntry[] {
  if (!text) return [];
  const parsed = JSON.parse(text) as { descriptors?: { key?: unknown; value?: unknown; rate_limit?: { requests_per_unit?: unknown } }[] };
  const out: LimitEntry[] = [];
  for (const d of parsed.descriptors ?? []) {
    const tokens = d.rate_limit?.requests_per_unit;
    if (typeof d.value !== "string" || typeof tokens !== "number") continue;
    if (d.key === "team") out.push({ scope: "team", team: d.value, agent: "", tokens });
    if (d.key === "agent") out.push({ scope: "agent", team: d.value.split(".")[0] ?? "", agent: d.value.split(".").slice(1).join("."), tokens });
  }
  return out;
}

const limitValue = (l: LimitEntry) => (l.scope === "team" ? l.team : `${l.team}.${l.agent}`);

/** JSON is YAML: the service reads this text as its config. Sorted, so the same caps give the same text. */
function renderLimits(limits: readonly LimitEntry[]): string {
  const descriptors = limits
    .map((l) => ({ key: l.scope, value: limitValue(l), rate_limit: { unit: RATELIMIT_UNIT, requests_per_unit: l.tokens } }))
    .sort((a, b) => `${a.key}/${a.value}`.localeCompare(`${b.key}/${b.value}`));
  return JSON.stringify({ domain: RATELIMIT_DOMAIN, descriptors }, null, 2);
}

const entryValue = (c: Extract<Change, { kind: "set-hash" }>) => JSON.stringify({ keyHash: c.keyHash, metadata: { team: c.team, agent: c.agent } });

/** Only the team namespaces are read: a registration's team is its namespace's, never what its data claims. */
export async function readState(kube: KubeClient, config: MinterConfig): Promise<State> {
  const registrations: Registration[] = [];
  const secrets: KeySecret[] = [];
  const skipped: string[] = [];
  for (const team of config.teams) {
    const namespace = teamNamespace(team);
    for (const cm of await kube.listConfigMaps(namespace, REGISTRATION_SELECTOR)) {
      const agent = cm.data.agent ?? "";
      if (cm.data.team !== team) {
        skipped.push(`${namespace}/${cm.name}: claims team ${JSON.stringify(cm.data.team ?? "")}, but lives in ${namespace}`);
        continue;
      }
      const tokenCap = /^[1-9][0-9]*$/.test(cm.data.tokenCap ?? "") ? Number(cm.data.tokenCap) : undefined;
      registrations.push({ team, agent, tools: parseTools(cm.data.mcpTools), tokenCap });
      if (config.budgets === undefined) continue;
      if (config.budgets[team] === undefined) skipped.push(`${namespace}/${cm.name}: team ${team} has no budget in the budgets file, so agent ${agent} gets no key and no cap`);
      else if (tokenCap === undefined) skipped.push(`${namespace}/${cm.name}: tokenCap ${JSON.stringify(cm.data.tokenCap ?? "")} is not a whole number of tokens, so agent ${agent} gets no key and no cap`);
    }
    for (const meta of await kube.listSecretMetadata(namespace, KEY_SELECTOR)) {
      secrets.push({ namespace, name: meta.name, team, agent: meta.labels[AGENT_LABEL] ?? "", keyHash: meta.annotations[KEY_HASH_ANNOTATION] ?? "" });
    }
  }
  const apiKeys = await kube.getConfigMap(config.apiKeys.namespace, config.apiKeys.name);
  const hashes = Object.entries(apiKeys.data).map(([entry, value]) => parseEntry(entry, value));
  const policies = (await kube.listMcpPolicies(config.mcp.namespace, POLICY_SELECTOR)).map((p) => toToolPolicy(p, config));
  const limits = config.rateLimit ? parseLimits((await kube.getConfigMap(config.rateLimit.namespace, config.rateLimit.name)).data[RATELIMIT_FILE]) : undefined;
  return { registrations, current: { secrets, hashes, policies, limits }, skipped };
}

/** All cap changes in one write of the ratelimit config, before the hash entries that let a key in. */
async function applyLimits(kube: KubeClient, config: MinterConfig, changes: readonly Change[]): Promise<void> {
  const { rateLimit } = config;
  if (!rateLimit || !changes.some((c) => c.kind === "set-limit" || c.kind === "delete-limit")) return;
  const held = new Map(parseLimits((await kube.getConfigMap(rateLimit.namespace, rateLimit.name)).data[RATELIMIT_FILE]).map((l) => [`${l.scope}/${l.team}/${l.agent}`, l]));
  for (const c of changes) {
    if (c.kind === "set-limit") held.set(`${c.scope}/${c.team}/${c.agent}`, { scope: c.scope, team: c.team, agent: c.agent, tokens: c.tokens });
    if (c.kind === "delete-limit") held.delete(`${c.scope}/${c.team}/${c.agent}`);
  }
  await kube.patchConfigMapData(rateLimit.namespace, rateLimit.name, { [RATELIMIT_FILE]: renderLimits([...held.values()]) });
}

/** New Secrets and tool policies first, then every hash entry in one patch, then the policies and Secrets that go. */
export async function applyChanges(kube: KubeClient, config: MinterConfig, changes: readonly Change[]): Promise<void> {
  const patch: Record<string, string | null> = {};
  for (const c of changes) {
    if (c.kind === "put-secret") {
      await kube.putSecret(c.namespace, {
        name: c.name,
        labels: { [MANAGED_BY_LABEL]: "minter", [KEY_LABEL]: "true", [AGENT_LABEL]: c.agent },
        annotations: { [KEY_HASH_ANNOTATION]: c.keyHash },
        stringData: { [SECRET_KEY]: c.key },
      });
    }
    if (c.kind === "put-policy") {
      await kube.putMcpPolicy(config.mcp.namespace, {
        name: c.name,
        labels: { [MANAGED_BY_LABEL]: "minter", [MCP_TOOLS_LABEL]: "true", [TEAM_LABEL]: c.team, [AGENT_LABEL]: c.agent },
        targetRefs: backendRefs(config),
        matchExpressions: [c.rule],
      });
    }
    if (c.kind === "set-hash") patch[c.entry] = entryValue(c);
    if (c.kind === "delete-hash") patch[c.entry] = null;
  }
  await applyLimits(kube, config, changes);
  if (Object.keys(patch).length > 0) await kube.patchConfigMapData(config.apiKeys.namespace, config.apiKeys.name, patch);
  for (const c of changes) {
    if (c.kind === "delete-policy") await kube.deleteMcpPolicy(config.mcp.namespace, c.name);
    if (c.kind === "delete-secret") await kube.deleteSecret(c.namespace, c.name);
  }
}

/** One minter run: read, plan, apply. Returns the changes it applied; onSkip hears each registration it ignored and why. */
export async function runOnce(kube: KubeClient, config: MinterConfig, newKey: () => string = randomKey, onSkip: (why: string) => void = () => {}): Promise<Change[]> {
  const state = await readState(kube, config);
  for (const why of state.skipped) onSkip(why);
  const changes = plan(state.registrations, config.teams, state.current, newKey, config.budgets);
  await applyChanges(kube, config, changes);
  return changes;
}

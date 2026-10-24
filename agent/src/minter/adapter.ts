// The minter's thin Kubernetes side: read the registrations, the key Secrets (metadata only),
// agentgateway's API-key ConfigMap and the minter's MCP tool policies; hand them to plan();
// apply what it returns.
import type { KubeClient, McpPolicy, TargetRef } from "./kube.ts";
import { type Change, type Current, type HashEntry, type KeySecret, plan, randomKey, type Registration, teamNamespace, type ToolPolicy } from "./plan.ts";

/** apiKeys: agentgateway's API-key ConfigMap. mcp: where the agents' tool policies go, and the catalog MCP backends they cover. */
export type MinterConfig = { teams: readonly string[]; apiKeys: { namespace: string; name: string }; mcp: { namespace: string; backends: readonly string[] } };
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
      registrations.push({ team, agent, tools: parseTools(cm.data.mcpTools) });
    }
    for (const meta of await kube.listSecretMetadata(namespace, KEY_SELECTOR)) {
      secrets.push({ namespace, name: meta.name, team, agent: meta.labels[AGENT_LABEL] ?? "", keyHash: meta.annotations[KEY_HASH_ANNOTATION] ?? "" });
    }
  }
  const apiKeys = await kube.getConfigMap(config.apiKeys.namespace, config.apiKeys.name);
  const hashes = Object.entries(apiKeys.data).map(([entry, value]) => parseEntry(entry, value));
  const policies = (await kube.listMcpPolicies(config.mcp.namespace, POLICY_SELECTOR)).map((p) => toToolPolicy(p, config));
  return { registrations, current: { secrets, hashes, policies }, skipped };
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
  const changes = plan(state.registrations, config.teams, state.current, newKey);
  await applyChanges(kube, config, changes);
  return changes;
}

// The minter's pure core. plan() compares the registrations with what the cluster holds (the
// agents' key Secrets, agentgateway's API-key entries and its MCP tool policies) and returns the
// changes that make every registered agent of a listed team hold exactly one key and one tool
// policy, and nothing else hold either.
// It reads no plaintext key: a Secret's key is known by the hash recorded on it.
import { createHash, randomBytes } from "node:crypto";

/** An agent the values-file chart registered (its registration ConfigMap), with the MCP tool names of its catalog tools. */
export type Registration = { team: string; agent: string; tools: readonly string[]; tokenCap?: number };
/** A key Secret the minter made: where it is, whose it is, and the hash of its key. */
export type KeySecret = { namespace: string; name: string; team: string; agent: string; keyHash: string };
/** An entry of agentgateway's API-key ConfigMap. */
export type HashEntry = { entry: string; team: string; agent: string; keyHash: string };
/** An agent's MCP tool policy in agentgateway: its CEL rule, or "" when it is not one the minter would write. */
export type ToolPolicy = { name: string; team: string; agent: string; rule: string };
/** A monthly token cap in the ratelimit config: one per agent, one per team (agent is "" for a team). */
export type LimitEntry = { scope: "agent" | "team"; team: string; agent: string; tokens: number };
/** The platform's monthly token budget per team (the budgets file). */
export type Budgets = Readonly<Record<string, number>>;
export type Current = { secrets: readonly KeySecret[]; hashes: readonly HashEntry[]; policies: readonly ToolPolicy[]; limits?: readonly LimitEntry[] };
export type Change =
  | { kind: "put-secret"; namespace: string; name: string; team: string; agent: string; key: string; keyHash: string }
  | { kind: "delete-secret"; namespace: string; name: string }
  | { kind: "set-hash"; entry: string; team: string; agent: string; keyHash: string }
  | { kind: "delete-hash"; entry: string }
  | { kind: "put-policy"; name: string; team: string; agent: string; rule: string }
  | { kind: "delete-policy"; name: string }
  | { kind: "set-limit"; scope: "agent" | "team"; team: string; agent: string; tokens: number }
  | { kind: "delete-limit"; scope: "agent" | "team"; team: string; agent: string };

// The values-file schema's patterns (platform/charts/agent/values.schema.json).
export const TEAM_PATTERN = /^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$/;
const AGENT_PATTERN = /^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$/;
// An MCP tool name as the catalog has them (platform/charts/agent/templates/_helpers.tpl).
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const KEY_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const KEY_BYTES = 32;

export const teamNamespace = (team: string): string => `team-${team}`;
/** The Secret the agent's ModelConfig names (platform/charts/agent/templates/agent.yaml). */
export const keySecretName = (agent: string): string => `${agent}-agent-key`;
export const hashEntryName = (team: string, agent: string): string => `${team}.${agent}`;
export const hashKey = (key: string): string => `sha256:${createHash("sha256").update(key).digest("hex")}`;
export const randomKey = (): string => randomBytes(KEY_BYTES).toString("base64url");

const idOf = (team: string, agent: string) => `${team}/${agent}`;
const limitId = (l: { scope: string; team: string; agent: string }) => `${l.scope}/${l.team}/${l.agent}`;
const isTokenCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** The agent's MCP tool policy in agentgateway (one per agent: policies on a backend merge). */
export const toolPolicyName = (team: string, agent: string): string => `mcp-tools.${team}.${agent}`;

/** The tools a policy may name: well-formed MCP tool names, each once, sorted. Anything else could break out of the CEL rule. */
function allowedTools(tools: readonly string[]): string[] {
  return [...new Set(tools.filter((t) => TOOL_PATTERN.test(t)))].sort();
}

/**
 * The CEL rule that lets one caller, by its key's metadata, see and call only its tools. Every
 * part is a name the schema patterns allow, so JSON string quoting is CEL string quoting.
 */
export function toolRule(team: string, agent: string, tools: readonly string[]): string {
  const names = tools.map((t) => JSON.stringify(t)).join(", ");
  return `apiKey.team == ${JSON.stringify(team)} && apiKey.agent == ${JSON.stringify(agent)} && mcp.tool.name in [${names}]`;
}

/** The registrations that get a key: a listed team, names the schema allows, each once. */
function wanted(registrations: readonly Registration[], teams: readonly string[], budgets?: Budgets): Registration[] {
  const listed = new Set(teams);
  const byId = new Map<string, Registration>();
  for (const r of registrations) {
    if (!listed.has(r.team) || !TEAM_PATTERN.test(r.team) || !AGENT_PATTERN.test(r.agent)) continue;
    // With budgets, a team needs one and an agent needs a cap, or it gets neither key nor cap.
    if (budgets !== undefined && (!isTokenCount(budgets[r.team]) || !isTokenCount(r.tokenCap))) {
      continue;
    }
    byId.set(idOf(r.team, r.agent), { team: r.team, agent: r.agent, tools: allowedTools(r.tools), tokenCap: r.tokenCap });
  }
  return [...byId.values()];
}

/** A Secret this registration can keep: in its place, owned by it, with a well-formed hash. */
function usableSecret(r: Registration, secrets: readonly KeySecret[]): KeySecret | undefined {
  return secrets.find(
    (s) => s.namespace === teamNamespace(r.team) && s.name === keySecretName(r.agent) && s.team === r.team && s.agent === r.agent && KEY_HASH_PATTERN.test(s.keyHash),
  );
}

/** The caps to hold: one per wanted agent, one per budgeted listed team. */
function wantedLimits(desired: readonly Registration[], teams: readonly string[], budgets: Budgets): LimitEntry[] {
  const agents = desired.map((r): LimitEntry => ({ scope: "agent", team: r.team, agent: r.agent, tokens: r.tokenCap ?? 0 }));
  const budgeted = teams.filter((t) => TEAM_PATTERN.test(t) && isTokenCount(budgets[t]));
  const teamCaps = [...new Set(budgeted)].map((t): LimitEntry => ({ scope: "team", team: t, agent: "", tokens: budgets[t]! }));
  return [...teamCaps, ...agents];
}

/** Set what differs from the held caps; delete what is held and no longer wanted. */
function limitChanges(want: readonly LimitEntry[], have: readonly LimitEntry[]): { sets: Change[]; deletes: Change[] } {
  const held = new Map(have.map((l) => [limitId(l), l]));
  const wantedIds = new Set(want.map(limitId));
  const sets = want.filter((l) => held.get(limitId(l))?.tokens !== l.tokens).map((l): Change => ({ kind: "set-limit", ...l }));
  const deletes = [...held.values()]
    .filter((l) => !wantedIds.has(limitId(l)))
    .map((l): Change => ({ kind: "delete-limit", scope: l.scope, team: l.team, agent: l.agent }));
  return { sets, deletes };
}

/**
 * With budgets, only teams that have one get keys, and plan also keeps the agent and team token
 * caps (current.limits); without budgets it touches keys alone.
 */
export function plan(registrations: readonly Registration[], teams: readonly string[], current: Current, newKey: () => string = randomKey, budgets?: Budgets): Change[] {
  const desired = wanted(registrations, teams, budgets);
  const puts: Change[] = [];
  const sets: Change[] = [];
  const policyPuts: Change[] = [];
  const keptSecrets = new Set<string>();
  const keptEntries = new Set<string>();
  const keptPolicies = new Set<string>();

  for (const r of desired) {
    const namespace = teamNamespace(r.team);
    const name = keySecretName(r.agent);
    const entry = hashEntryName(r.team, r.agent);
    keptSecrets.add(`${namespace}/${name}`);
    keptEntries.add(entry);
    let keyHash = usableSecret(r, current.secrets)?.keyHash;
    if (keyHash === undefined) {
      const key = newKey();
      keyHash = hashKey(key);
      puts.push({ kind: "put-secret", namespace, name, team: r.team, agent: r.agent, key, keyHash });
    }
    const have = current.hashes.find((h) => h.entry === entry);
    if (have?.keyHash !== keyHash || have.team !== r.team || have.agent !== r.agent) {
      sets.push({ kind: "set-hash", entry, team: r.team, agent: r.agent, keyHash });
    }
    const policy = toolPolicyName(r.team, r.agent);
    const rule = toolRule(r.team, r.agent, r.tools);
    keptPolicies.add(policy);
    const havePolicy = current.policies.find((p) => p.name === policy);
    if (havePolicy?.rule !== rule || havePolicy.team !== r.team || havePolicy.agent !== r.agent) {
      policyPuts.push({ kind: "put-policy", name: policy, team: r.team, agent: r.agent, rule });
    }
  }

  // The policy before the hash: a key never works without its tool policy. On removal, the
  // hash first, then the policy and the Secret: the key stops working before the rest goes.
  const entryDeletes = [...new Set(current.hashes.map((h) => h.entry))]
    .filter((entry) => !keptEntries.has(entry))
    .map((entry): Change => ({ kind: "delete-hash", entry }));
  const policyDeletes = [...new Set(current.policies.map((p) => p.name))]
    .filter((name) => !keptPolicies.has(name))
    .map((name): Change => ({ kind: "delete-policy", name }));
  const stale = new Map(current.secrets.filter((s) => !keptSecrets.has(`${s.namespace}/${s.name}`)).map((s) => [`${s.namespace}/${s.name}`, s]));
  const secretDeletes = [...stale.values()].map((s): Change => ({ kind: "delete-secret", namespace: s.namespace, name: s.name }));
  const limits = budgets === undefined ? { sets: [], deletes: [] } : limitChanges(wantedLimits(desired, teams, budgets), current.limits ?? []);
  // The cap is set before the key's hash can admit a call, and removed after the hash is gone.
  return [...puts, ...policyPuts, ...limits.sets, ...sets, ...entryDeletes, ...limits.deletes, ...policyDeletes, ...secretDeletes];
}

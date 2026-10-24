// The minter's pure core. plan() compares the registrations with what the cluster holds (the
// agents' key Secrets and agentgateway's API-key entries) and returns the changes that make
// every registered agent of a listed team hold exactly one key, and nothing else hold one.
// It reads no plaintext key: a Secret's key is known by the hash recorded on it.
import { createHash, randomBytes } from "node:crypto";

/** An agent the values-file chart registered (its registration ConfigMap). */
export type Registration = { team: string; agent: string };
/** A key Secret the minter made: where it is, whose it is, and the hash of its key. */
export type KeySecret = { namespace: string; name: string; team: string; agent: string; keyHash: string };
/** An entry of agentgateway's API-key ConfigMap. */
export type HashEntry = { entry: string; team: string; agent: string; keyHash: string };
export type Current = { secrets: readonly KeySecret[]; hashes: readonly HashEntry[] };
export type Change =
  | { kind: "put-secret"; namespace: string; name: string; team: string; agent: string; key: string; keyHash: string }
  | { kind: "delete-secret"; namespace: string; name: string }
  | { kind: "set-hash"; entry: string; team: string; agent: string; keyHash: string }
  | { kind: "delete-hash"; entry: string };

// The values-file schema's patterns (platform/charts/agent/values.schema.json).
const TEAM_PATTERN = /^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$/;
const AGENT_PATTERN = /^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$/;
const KEY_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const KEY_BYTES = 32;

export const teamNamespace = (team: string): string => `team-${team}`;
/** The Secret the agent's ModelConfig names (platform/charts/agent/templates/agent.yaml). */
export const keySecretName = (agent: string): string => `${agent}-agent-key`;
export const hashEntryName = (team: string, agent: string): string => `${team}.${agent}`;
export const hashKey = (key: string): string => `sha256:${createHash("sha256").update(key).digest("hex")}`;
export const randomKey = (): string => randomBytes(KEY_BYTES).toString("base64url");

const idOf = (team: string, agent: string) => `${team}/${agent}`;

/** The registrations that get a key: a listed team, names the schema allows, each once. */
function wanted(registrations: readonly Registration[], teams: readonly string[]): Registration[] {
  const listed = new Set(teams);
  const byId = new Map<string, Registration>();
  for (const r of registrations) {
    if (!listed.has(r.team) || !TEAM_PATTERN.test(r.team) || !AGENT_PATTERN.test(r.agent)) continue;
    byId.set(idOf(r.team, r.agent), { team: r.team, agent: r.agent });
  }
  return [...byId.values()];
}

/** A Secret this registration can keep: in its place, owned by it, with a well-formed hash. */
function usableSecret(r: Registration, secrets: readonly KeySecret[]): KeySecret | undefined {
  return secrets.find(
    (s) => s.namespace === teamNamespace(r.team) && s.name === keySecretName(r.agent) && s.team === r.team && s.agent === r.agent && KEY_HASH_PATTERN.test(s.keyHash),
  );
}

export function plan(registrations: readonly Registration[], teams: readonly string[], current: Current, newKey: () => string = randomKey): Change[] {
  const desired = wanted(registrations, teams);
  const puts: Change[] = [];
  const sets: Change[] = [];
  const keptSecrets = new Set<string>();
  const keptEntries = new Set<string>();

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
  }

  // Hash first, then Secret: the key stops working before it is gone.
  const entryDeletes = [...new Set(current.hashes.map((h) => h.entry))]
    .filter((entry) => !keptEntries.has(entry))
    .map((entry): Change => ({ kind: "delete-hash", entry }));
  const stale = new Map(current.secrets.filter((s) => !keptSecrets.has(`${s.namespace}/${s.name}`)).map((s) => [`${s.namespace}/${s.name}`, s]));
  const secretDeletes = [...stale.values()].map((s): Change => ({ kind: "delete-secret", namespace: s.namespace, name: s.name }));
  return [...puts, ...sets, ...entryDeletes, ...secretDeletes];
}

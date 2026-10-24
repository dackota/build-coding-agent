// The minter's CronJob entrypoint (platform/charts/teams/templates/minter.yaml): one run that
// gives every registered agent of a listed team its own model key and removes the keys of
// agents that are gone. It logs one JSON line per change, never a key, and exits non-zero on
// any failure; the next run (a minute later) converges from wherever this one stopped.
import { runOnce, type MinterConfig } from "./adapter.ts";
import { inClusterKube } from "./kube.ts";
import { TEAM_PATTERN, type Change } from "./plan.ts";

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}

/** The change without its key: what a log line may show. */
function describe(c: Change): Record<string, unknown> {
  if (c.kind === "put-secret") return { kind: c.kind, namespace: c.namespace, name: c.name, keyHash: c.keyHash };
  return { ...c };
}

function configFromEnv(env: NodeJS.ProcessEnv): MinterConfig {
  const teams = (env.MINTER_TEAMS ?? "").split(",").filter((t) => t !== "");
  if (teams.length === 0) throw new Error("MINTER_TEAMS is empty: set it to the team list, comma-separated");
  const bad = teams.filter((t) => !TEAM_PATTERN.test(t));
  if (bad.length > 0) throw new Error(`MINTER_TEAMS has names that are not team names: ${bad.join(", ")}`);
  const namespace = env.MINTER_API_KEYS_NAMESPACE ?? "";
  const name = env.MINTER_API_KEYS_CONFIGMAP ?? "";
  if (namespace === "" || name === "") throw new Error("MINTER_API_KEYS_NAMESPACE and MINTER_API_KEYS_CONFIGMAP must name agentgateway's API-key ConfigMap");
  return { teams, apiKeys: { namespace, name } };
}

try {
  const config = configFromEnv(process.env);
  const changes = await runOnce(inClusterKube(), config, undefined, (why) => log("registration-skipped", { why }));
  for (const c of changes) log("applied", describe(c));
  log("run-done", { teams: config.teams, changes: changes.length });
} catch (err) {
  log("run-failed", { error: (err as Error).message });
  process.exitCode = 1;
}

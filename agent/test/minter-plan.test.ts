// The minter's pure core: plan(registrations, teams, current) -> changes. Property tests over
// generated and adversarial sets, with a model of what applying the changes does to the cluster.
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Change, type Current, type Registration, plan, toolRule } from "../src/minter/plan.ts";

const KNOWN_TEAMS = ["platform", "payments", "search"];
const UNKNOWN_TEAMS = ["ghost", "", "Team-Caps", "x".repeat(30)];
const GOOD_AGENTS = ["hello-agent", "docs-agent", "triage-agent", "a", "a1", "pay-bot", "x".repeat(40)];
const BAD_AGENTS = ["", "UPPER", "a.b", "-lead", "trail-", "x".repeat(41), "a/b", "with space"];
const GOOD_TOOLS = ["issue_read", "create_branch", "push_files", "create_pull_request", "delete_branch", "t".repeat(64)];
// Names a rule must never carry: they could break out of the CEL string or the list.
const BAD_TOOLS = ["", "Issue_Read", 'x" || true || "', "a b", "t".repeat(65), "1tool", "x]"];
const EMPTY: Current = { secrets: [], hashes: [], policies: [] };

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const id = (team: string, agent: string) => `${team}/${agent}`;
const isValid = (r: Registration) => KNOWN_TEAMS.includes(r.team) && GOOD_AGENTS.includes(r.agent);

/** A fresh key per call, distinct and recognisable in a JSON dump. */
function keyMaker(): () => string {
  let n = 0;
  return () => `plaintext-key-${++n}-${"k".repeat(20)}`;
}

/** The tools a registration's policy should name: its well-formed tool names, each once, sorted. */
const allowedTools = (r: Registration) => [...new Set(r.tools.filter((t) => GOOD_TOOLS.includes(t)))].sort();

/** What the cluster looks like once the changes are applied: Secrets by namespace/name, hash entries and tool policies by name. */
function applyModel(current: Current, changes: readonly Change[]): Current {
  const secrets = new Map(current.secrets.map((s) => [`${s.namespace}/${s.name}`, s]));
  const hashes = new Map(current.hashes.map((h) => [h.entry, h]));
  const policies = new Map(current.policies.map((p) => [p.name, p]));
  for (const c of changes) {
    switch (c.kind) {
      case "put-secret":
        secrets.set(`${c.namespace}/${c.name}`, { namespace: c.namespace, name: c.name, team: c.team, agent: c.agent, keyHash: c.keyHash });
        break;
      case "delete-secret":
        secrets.delete(`${c.namespace}/${c.name}`);
        break;
      case "set-hash":
        hashes.set(c.entry, { entry: c.entry, team: c.team, agent: c.agent, keyHash: c.keyHash });
        break;
      case "delete-hash":
        hashes.delete(c.entry);
        break;
      case "put-policy":
        policies.set(c.name, { name: c.name, team: c.team, agent: c.agent, rule: c.rule });
        break;
      case "delete-policy":
        policies.delete(c.name);
        break;
    }
  }
  return { secrets: [...secrets.values()], hashes: [...hashes.values()], policies: [...policies.values()] };
}

const teamArb = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...KNOWN_TEAMS) }, { weight: 1, arbitrary: fc.constantFrom(...UNKNOWN_TEAMS) });
const agentArb = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...GOOD_AGENTS) }, { weight: 1, arbitrary: fc.constantFrom(...BAD_AGENTS) });
const toolArb = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...GOOD_TOOLS) }, { weight: 1, arbitrary: fc.constantFrom(...BAD_TOOLS) });
const registrationArb: fc.Arbitrary<Registration> = fc.record({ team: teamArb, agent: agentArb, tools: fc.array(toolArb, { maxLength: 8 }) });
// Large lists and duplicates: the agent pool is small, so a long list repeats entries.
const registrationsArb = fc.array(registrationArb, { maxLength: 300 });

/** A cluster state left by an earlier run for other registrations, plus junk: stale, mismatched, and unannotated entries. */
const currentArb: fc.Arbitrary<Current> = fc
  .tuple(
    registrationsArb,
    fc.array(fc.record({ team: teamArb, agent: agentArb, keyHash: fc.option(fc.constantFrom(sha("old-1"), sha("old-2"), "garbage"), { nil: undefined }) }), { maxLength: 20 }),
    fc.array(fc.record({ entry: fc.string({ maxLength: 12 }), team: teamArb, agent: agentArb, keyHash: fc.constantFrom(sha("old-1"), sha("old-3"), "") }), { maxLength: 20 }),
    fc.array(fc.record({ name: fc.string({ maxLength: 20 }), team: teamArb, agent: agentArb, rule: fc.constantFrom("", "true", 'apiKey.agent == "x"') }), { maxLength: 20 }),
  )
  .map(([earlier, strays, strayHashes, strayPolicies]) => {
    const settled = applyModel(EMPTY, plan(earlier, KNOWN_TEAMS, EMPTY, keyMaker()));
    const straySecrets = strays.map((s) => ({ namespace: `team-${s.team}`, name: `${s.agent}-agent-key`, team: s.team, agent: s.agent, keyHash: s.keyHash }));
    return applyModel(settled, [
      ...straySecrets.map((s) => ({ kind: "put-secret" as const, ...s, key: "unused", keyHash: s.keyHash ?? "" })),
      ...strayHashes.map((h) => ({ kind: "set-hash" as const, ...h })),
      ...strayPolicies.map((p) => ({ kind: "put-policy" as const, ...p })),
    ]);
  });

describe("minter plan: properties", () => {
  it("every registration of a known team has exactly one key Secret and one hash entry", () => {
    fc.assert(
      fc.property(registrationsArb, currentArb, (registrations, current) => {
        const after = applyModel(current, plan(registrations, KNOWN_TEAMS, current, keyMaker()));
        for (const r of registrations.filter(isValid)) {
          const secrets = after.secrets.filter((s) => s.team === r.team && s.agent === r.agent);
          const hashes = after.hashes.filter((h) => h.team === r.team && h.agent === r.agent);
          expect(secrets, id(r.team, r.agent)).toHaveLength(1);
          expect(hashes, id(r.team, r.agent)).toHaveLength(1);
          expect(secrets[0]!.namespace).toBe(`team-${r.team}`);
          expect(secrets[0]!.name).toBe(`${r.agent}-agent-key`);
          expect(hashes[0]!.keyHash).toBe(secrets[0]!.keyHash);
          expect(hashes[0]!.keyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
        }
      }),
    );
  });

  it("a removed registration, an unknown team, or a bad name leaves no Secret and no hash", () => {
    fc.assert(
      fc.property(registrationsArb, currentArb, (registrations, current) => {
        const after = applyModel(current, plan(registrations, KNOWN_TEAMS, current, keyMaker()));
        const wanted = new Set(registrations.filter(isValid).map((r) => id(r.team, r.agent)));
        for (const s of after.secrets) expect(wanted.has(id(s.team, s.agent)), `secret ${s.namespace}/${s.name}`).toBe(true);
        for (const h of after.hashes) expect(wanted.has(id(h.team, h.agent)), `hash ${h.entry}`).toBe(true);
        expect(after.secrets).toHaveLength(wanted.size);
        expect(after.hashes).toHaveLength(wanted.size);
      }),
    );
  });

  it("every registration of a known team has exactly one tool policy, naming its tools", () => {
    fc.assert(
      fc.property(registrationsArb, currentArb, (registrations, current) => {
        const after = applyModel(current, plan(registrations, KNOWN_TEAMS, current, keyMaker()));
        const last = new Map(registrations.filter(isValid).map((r) => [id(r.team, r.agent), r]));
        for (const r of last.values()) {
          const policies = after.policies.filter((p) => p.team === r.team && p.agent === r.agent);
          expect(policies, id(r.team, r.agent)).toHaveLength(1);
          expect(policies[0]!.name).toBe(`mcp-tools.${r.team}.${r.agent}`);
          expect(policies[0]!.rule).toBe(toolRule(r.team, r.agent, allowedTools(r)));
          for (const bad of BAD_TOOLS.filter((t) => t !== "")) expect(policies[0]!.rule).not.toContain(bad);
        }
      }),
    );
  });

  it("a removed registration, an unknown team, or a bad name leaves no tool policy", () => {
    fc.assert(
      fc.property(registrationsArb, currentArb, (registrations, current) => {
        const after = applyModel(current, plan(registrations, KNOWN_TEAMS, current, keyMaker()));
        const wanted = new Set(registrations.filter(isValid).map((r) => id(r.team, r.agent)));
        for (const p of after.policies) expect(wanted.has(id(p.team, p.agent)), `policy ${p.name}`).toBe(true);
        expect(after.policies).toHaveLength(wanted.size);
      }),
    );
  });

  it("plan on its own output gives no changes", () => {
    fc.assert(
      fc.property(registrationsArb, currentArb, (registrations, current) => {
        const after = applyModel(current, plan(registrations, KNOWN_TEAMS, current, keyMaker()));
        expect(plan(registrations, KNOWN_TEAMS, after, keyMaker())).toEqual([]);
      }),
    );
  });

  it("a key's plaintext appears only in its Secret change", () => {
    fc.assert(
      fc.property(registrationsArb, currentArb, (registrations, current) => {
        const changes = plan(registrations, KNOWN_TEAMS, current, keyMaker());
        const keys = changes.flatMap((c) => (c.kind === "put-secret" ? [c.key] : []));
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) {
          const holders = changes.filter((c) => JSON.stringify(c).includes(key));
          expect(holders).toHaveLength(1);
          expect(holders[0]!.kind).toBe("put-secret");
          const own = holders[0] as Extract<Change, { kind: "put-secret" }>;
          expect(own.keyHash).toBe(sha(key));
        }
      }),
    );
  });
});

describe("minter plan: examples", () => {
  it("gives nothing for no registrations and an empty cluster", () => {
    expect(plan([], KNOWN_TEAMS, EMPTY, keyMaker())).toEqual([]);
  });

  it("makes one key for a registration listed twice", () => {
    const changes = plan([{ team: "platform", agent: "hello-agent", tools: [] }, { team: "platform", agent: "hello-agent", tools: [] }], KNOWN_TEAMS, EMPTY, keyMaker());
    expect(changes.map((c) => c.kind).sort()).toEqual(["put-policy", "put-secret", "set-hash"]);
    const put = changes.find((c) => c.kind === "put-secret")!;
    expect(put).toMatchObject({ namespace: "team-platform", name: "hello-agent-agent-key", team: "platform", agent: "hello-agent" });
    expect(changes.find((c) => c.kind === "set-hash")).toEqual({ kind: "set-hash", entry: "platform.hello-agent", team: "platform", agent: "hello-agent", keyHash: sha("plaintext-key-1-" + "k".repeat(20)) });
  });

  it("gives a team not on the team list nothing", () => {
    expect(plan([{ team: "ghost", agent: "hello-agent", tools: ["issue_read"] }], KNOWN_TEAMS, EMPTY, keyMaker())).toEqual([]);
  });

  it("repairs a missing hash from the Secret's recorded hash without minting a new key", () => {
    const current: Current = {
      secrets: [{ namespace: "team-platform", name: "hello-agent-agent-key", team: "platform", agent: "hello-agent", keyHash: sha("existing") }],
      hashes: [],
      policies: [{ name: "mcp-tools.platform.hello-agent", team: "platform", agent: "hello-agent", rule: toolRule("platform", "hello-agent", []) }],
    };
    expect(plan([{ team: "platform", agent: "hello-agent", tools: [] }], KNOWN_TEAMS, current, keyMaker())).toEqual([
      { kind: "set-hash", entry: "platform.hello-agent", team: "platform", agent: "hello-agent", keyHash: sha("existing") },
    ]);
  });

  it("removes the Secret, hash and tool policy of a deleted agent", () => {
    const current: Current = {
      secrets: [{ namespace: "team-platform", name: "gone-agent-key", team: "platform", agent: "gone", keyHash: sha("k") }],
      hashes: [{ entry: "platform.gone", team: "platform", agent: "gone", keyHash: sha("k") }],
      policies: [{ name: "mcp-tools.platform.gone", team: "platform", agent: "gone", rule: toolRule("platform", "gone", ["issue_read"]) }],
    };
    expect(plan([], KNOWN_TEAMS, current, keyMaker())).toEqual([
      { kind: "delete-hash", entry: "platform.gone" },
      { kind: "delete-policy", name: "mcp-tools.platform.gone" },
      { kind: "delete-secret", namespace: "team-platform", name: "gone-agent-key" },
    ]);
  });

  it("renders a tool rule that names the caller's team, agent and tools", () => {
    expect(toolRule("platform", "triage-agent", ["issue_read"])).toBe('apiKey.team == "platform" && apiKey.agent == "triage-agent" && mcp.tool.name in ["issue_read"]');
    expect(toolRule("platform", "quiet", [])).toBe('apiKey.team == "platform" && apiKey.agent == "quiet" && mcp.tool.name in []');
  });

  it("writes the policy before the key's hash, and rewrites a policy whose tools changed", () => {
    const changes = plan([{ team: "platform", agent: "hello-agent", tools: ["push_files", "create_branch", "push_files", "Bad"] }], KNOWN_TEAMS, EMPTY, keyMaker());
    expect(changes.map((c) => c.kind)).toEqual(["put-secret", "put-policy", "set-hash"]);
    expect(changes[1]).toEqual({
      kind: "put-policy",
      name: "mcp-tools.platform.hello-agent",
      team: "platform",
      agent: "hello-agent",
      rule: 'apiKey.team == "platform" && apiKey.agent == "hello-agent" && mcp.tool.name in ["create_branch", "push_files"]',
    });
    const after = applyModel(EMPTY, changes);
    expect(plan([{ team: "platform", agent: "hello-agent", tools: ["issue_read"] }], KNOWN_TEAMS, after, keyMaker())).toEqual([
      { kind: "put-policy", name: "mcp-tools.platform.hello-agent", team: "platform", agent: "hello-agent", rule: toolRule("platform", "hello-agent", ["issue_read"]) },
    ]);
  });

  it("keys a large list, one key per agent", () => {
    const registrations = Array.from({ length: 2000 }, (_, i) => ({ team: KNOWN_TEAMS[i % 3]!, agent: `agent-${i}`, tools: ["issue_read"] }));
    const changes = plan(registrations, KNOWN_TEAMS, EMPTY, keyMaker());
    expect(changes.filter((c) => c.kind === "put-secret")).toHaveLength(2000);
    expect(changes.filter((c) => c.kind === "set-hash")).toHaveLength(2000);
    expect(changes.filter((c) => c.kind === "put-policy")).toHaveLength(2000);
  });
});

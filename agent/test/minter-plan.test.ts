// The minter's pure core: plan(registrations, teams, current) -> changes. Property tests over
// generated and adversarial sets, with a model of what applying the changes does to the cluster.
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Change, type Current, type Registration, plan } from "../src/minter/plan.ts";

const KNOWN_TEAMS = ["platform", "payments", "search"];
const UNKNOWN_TEAMS = ["ghost", "", "Team-Caps", "x".repeat(30)];
const GOOD_AGENTS = ["hello-agent", "docs-agent", "triage-agent", "a", "a1", "pay-bot", "x".repeat(40)];
const BAD_AGENTS = ["", "UPPER", "a.b", "-lead", "trail-", "x".repeat(41), "a/b", "with space"];

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const id = (team: string, agent: string) => `${team}/${agent}`;
const isValid = (r: Registration) => KNOWN_TEAMS.includes(r.team) && GOOD_AGENTS.includes(r.agent);

/** A fresh key per call, distinct and recognisable in a JSON dump. */
function keyMaker(): () => string {
  let n = 0;
  return () => `plaintext-key-${++n}-${"k".repeat(20)}`;
}

/** What the cluster looks like once the changes are applied: Secrets by namespace/name, hash entries by name. */
function applyModel(current: Current, changes: readonly Change[]): Current {
  const secrets = new Map(current.secrets.map((s) => [`${s.namespace}/${s.name}`, s]));
  const hashes = new Map(current.hashes.map((h) => [h.entry, h]));
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
    }
  }
  return { secrets: [...secrets.values()], hashes: [...hashes.values()] };
}

const teamArb = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...KNOWN_TEAMS) }, { weight: 1, arbitrary: fc.constantFrom(...UNKNOWN_TEAMS) });
const agentArb = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...GOOD_AGENTS) }, { weight: 1, arbitrary: fc.constantFrom(...BAD_AGENTS) });
const registrationArb: fc.Arbitrary<Registration> = fc.record({ team: teamArb, agent: agentArb });
// Large lists and duplicates: the agent pool is small, so a long list repeats entries.
const registrationsArb = fc.array(registrationArb, { maxLength: 300 });

/** A cluster state left by an earlier run for other registrations, plus junk: stale, mismatched, and unannotated entries. */
const currentArb: fc.Arbitrary<Current> = fc
  .tuple(
    registrationsArb,
    fc.array(fc.record({ team: teamArb, agent: agentArb, keyHash: fc.option(fc.constantFrom(sha("old-1"), sha("old-2"), "garbage"), { nil: undefined }) }), { maxLength: 20 }),
    fc.array(fc.record({ entry: fc.string({ maxLength: 12 }), team: teamArb, agent: agentArb, keyHash: fc.constantFrom(sha("old-1"), sha("old-3"), "") }), { maxLength: 20 }),
  )
  .map(([earlier, strays, strayHashes]) => {
    const settled = applyModel({ secrets: [], hashes: [] }, plan(earlier, KNOWN_TEAMS, { secrets: [], hashes: [] }, keyMaker()));
    const straySecrets = strays.map((s) => ({ namespace: `team-${s.team}`, name: `${s.agent}-agent-key`, team: s.team, agent: s.agent, keyHash: s.keyHash }));
    return applyModel(settled, [
      ...straySecrets.map((s) => ({ kind: "put-secret" as const, ...s, key: "unused", keyHash: s.keyHash ?? "" })),
      ...strayHashes.map((h) => ({ kind: "set-hash" as const, ...h })),
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
    expect(plan([], KNOWN_TEAMS, { secrets: [], hashes: [] }, keyMaker())).toEqual([]);
  });

  it("makes one key for a registration listed twice", () => {
    const changes = plan([{ team: "platform", agent: "hello-agent" }, { team: "platform", agent: "hello-agent" }], KNOWN_TEAMS, { secrets: [], hashes: [] }, keyMaker());
    expect(changes.map((c) => c.kind).sort()).toEqual(["put-secret", "set-hash"]);
    const put = changes.find((c) => c.kind === "put-secret")!;
    expect(put).toMatchObject({ namespace: "team-platform", name: "hello-agent-agent-key", team: "platform", agent: "hello-agent" });
    expect(changes.find((c) => c.kind === "set-hash")).toEqual({ kind: "set-hash", entry: "platform.hello-agent", team: "platform", agent: "hello-agent", keyHash: sha("plaintext-key-1-" + "k".repeat(20)) });
  });

  it("gives a team not on the team list nothing", () => {
    expect(plan([{ team: "ghost", agent: "hello-agent" }], KNOWN_TEAMS, { secrets: [], hashes: [] }, keyMaker())).toEqual([]);
  });

  it("repairs a missing hash from the Secret's recorded hash without minting a new key", () => {
    const current: Current = {
      secrets: [{ namespace: "team-platform", name: "hello-agent-agent-key", team: "platform", agent: "hello-agent", keyHash: sha("existing") }],
      hashes: [],
    };
    expect(plan([{ team: "platform", agent: "hello-agent" }], KNOWN_TEAMS, current, keyMaker())).toEqual([
      { kind: "set-hash", entry: "platform.hello-agent", team: "platform", agent: "hello-agent", keyHash: sha("existing") },
    ]);
  });

  it("removes the Secret and hash of a deleted agent", () => {
    const current: Current = {
      secrets: [{ namespace: "team-platform", name: "gone-agent-key", team: "platform", agent: "gone", keyHash: sha("k") }],
      hashes: [{ entry: "platform.gone", team: "platform", agent: "gone", keyHash: sha("k") }],
    };
    expect(plan([], KNOWN_TEAMS, current, keyMaker())).toEqual([
      { kind: "delete-hash", entry: "platform.gone" },
      { kind: "delete-secret", namespace: "team-platform", name: "gone-agent-key" },
    ]);
  });

  it("keys a large list, one key per agent", () => {
    const registrations = Array.from({ length: 2000 }, (_, i) => ({ team: KNOWN_TEAMS[i % 3]!, agent: `agent-${i}` }));
    const changes = plan(registrations, KNOWN_TEAMS, { secrets: [], hashes: [] }, keyMaker());
    expect(changes.filter((c) => c.kind === "put-secret")).toHaveLength(2000);
    expect(changes.filter((c) => c.kind === "set-hash")).toHaveLength(2000);
  });
});

// Token caps: with budgets given, plan() also keeps the agent and team entries of the ratelimit config.
const BUDGETS = { platform: 50_000_000, payments: 10_000_000 };
const BUDGETED_TEAMS = Object.keys(BUDGETS);
const CAPS = [1, 1000, 1_000_000, 50_000_000];
const capArb = fc.constantFrom(...CAPS);
const capRegistrationArb = fc.record({ team: fc.oneof(fc.constantFrom(...KNOWN_TEAMS), fc.constantFrom(...UNKNOWN_TEAMS)), agent: fc.constantFrom(...GOOD_AGENTS), tokenCap: capArb });
const capRegistrationsArb = fc.array(capRegistrationArb, { maxLength: 200 });
const EMPTY: Current = { secrets: [], hashes: [], limits: [] };

/** The cluster after the changes, limits included. */
function applyAll(current: Current, changes: readonly Change[]): Current {
  const base = applyModel(current, changes);
  const limits = new Map((current.limits ?? []).map((l) => [`${l.scope}/${l.team}/${l.agent}`, l]));
  for (const c of changes) {
    if (c.kind === "set-limit") limits.set(`${c.scope}/${c.team}/${c.agent}`, { scope: c.scope, team: c.team, agent: c.agent, tokens: c.tokens });
    if (c.kind === "delete-limit") limits.delete(`${c.scope}/${c.team}/${c.agent}`);
  }
  return { ...base, limits: [...limits.values()] };
}

/** An earlier run's leftovers: caps for agents and teams that may be gone, or for the wrong amount. */
const staleLimitsArb = fc.array(
  fc.record({
    scope: fc.constantFrom("agent" as const, "team" as const),
    team: fc.constantFrom(...KNOWN_TEAMS, "ghost"),
    agent: fc.constantFrom(...GOOD_AGENTS),
    tokens: fc.constantFrom(7, 99),
  }),
  { maxLength: 20 },
);

describe("minter plan: token caps", () => {
  const hasBudget = (r: Registration) => BUDGETED_TEAMS.includes(r.team) && GOOD_AGENTS.includes(r.agent);

  it("every registration of a budgeted team has exactly one agent cap, with its own amount", () => {
    fc.assert(
      fc.property(capRegistrationsArb, staleLimitsArb, (registrations, stale) => {
        const current: Current = { ...EMPTY, limits: stale.map((l) => (l.scope === "team" ? { ...l, agent: "" } : l)) };
        const after = applyAll(current, plan(registrations, KNOWN_TEAMS, current, keyMaker(), BUDGETS));
        for (const r of registrations.filter(hasBudget)) {
          const caps = (after.limits ?? []).filter((l) => l.scope === "agent" && l.team === r.team && l.agent === r.agent);
          expect(caps, id(r.team, r.agent)).toHaveLength(1);
          const last = [...registrations].reverse().find((x) => x.team === r.team && x.agent === r.agent)!;
          expect(caps[0]!.tokens).toBe((last as Registration & { tokenCap: number }).tokenCap);
        }
      }),
    );
  });

  it("a team with no budget gets no key and no cap, and no agent of it keeps one", () => {
    fc.assert(
      fc.property(capRegistrationsArb, staleLimitsArb, (registrations, stale) => {
        const current: Current = { ...EMPTY, limits: stale.map((l) => (l.scope === "team" ? { ...l, agent: "" } : l)) };
        const after = applyAll(current, plan(registrations, KNOWN_TEAMS, current, keyMaker(), { platform: BUDGETS.platform }));
        for (const l of after.limits ?? []) expect(l.team, `${l.scope} cap of ${l.team}`).toBe("platform");
        for (const s of after.secrets) expect(s.team).toBe("platform");
        for (const h of after.hashes) expect(h.team).toBe("platform");
      }),
    );
  });

  it("holds one team cap per budgeted listed team, from the budgets file, and nothing else", () => {
    fc.assert(
      fc.property(capRegistrationsArb, staleLimitsArb, (registrations, stale) => {
        const current: Current = { ...EMPTY, limits: stale.map((l) => (l.scope === "team" ? { ...l, agent: "" } : l)) };
        const after = applyAll(current, plan(registrations, KNOWN_TEAMS, current, keyMaker(), BUDGETS));
        const teamCaps = (after.limits ?? []).filter((l) => l.scope === "team");
        expect(teamCaps.map((l) => [l.team, l.tokens]).sort()).toEqual(Object.entries(BUDGETS).sort());
        const wanted = new Set(registrations.filter(hasBudget).map((r) => id(r.team, r.agent)));
        expect((after.limits ?? []).filter((l) => l.scope === "agent")).toHaveLength(wanted.size);
      }),
    );
  });

  it("plan on its own output gives no changes", () => {
    fc.assert(
      fc.property(capRegistrationsArb, staleLimitsArb, (registrations, stale) => {
        const current: Current = { ...EMPTY, limits: stale.map((l) => (l.scope === "team" ? { ...l, agent: "" } : l)) };
        const after = applyAll(current, plan(registrations, KNOWN_TEAMS, current, keyMaker(), BUDGETS));
        expect(plan(registrations, KNOWN_TEAMS, after, keyMaker(), BUDGETS)).toEqual([]);
      }),
    );
  });

  it("a registration with no usable cap gets no key and no cap", () => {
    for (const tokenCap of [undefined, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(plan([{ team: "platform", agent: "hello-agent", tokenCap }], KNOWN_TEAMS, EMPTY, keyMaker(), BUDGETS).filter((c) => c.kind !== "set-limit" || c.scope !== "team")).toEqual([]);
    }
  });

  it("sets the caps before the key's hash and removes them after it", () => {
    const grown = plan([{ team: "platform", agent: "hello-agent", tokenCap: 1000 }], KNOWN_TEAMS, EMPTY, keyMaker(), BUDGETS);
    const kinds = grown.map((c) => c.kind);
    expect(kinds.indexOf("set-limit")).toBeLessThan(kinds.indexOf("set-hash"));
    const current: Current = {
      secrets: [{ namespace: "team-platform", name: "gone-agent-key", team: "platform", agent: "gone", keyHash: sha("k") }],
      hashes: [{ entry: "platform.gone", team: "platform", agent: "gone", keyHash: sha("k") }],
      limits: [{ scope: "agent", team: "platform", agent: "gone", tokens: 5 }, { scope: "team", team: "platform", agent: "", tokens: BUDGETS.platform }, { scope: "team", team: "payments", agent: "", tokens: BUDGETS.payments }],
    };
    const shrunk = plan([], KNOWN_TEAMS, current, keyMaker(), BUDGETS).map((c) => c.kind);
    expect(shrunk).toEqual(["delete-hash", "delete-limit", "delete-secret"]);
  });

  it("removes the cap of a deleted agent", () => {
    const current: Current = { ...EMPTY, limits: [{ scope: "agent", team: "platform", agent: "gone", tokens: 5 }, { scope: "team", team: "platform", agent: "", tokens: BUDGETS.platform }, { scope: "team", team: "payments", agent: "", tokens: BUDGETS.payments }] };
    expect(plan([], KNOWN_TEAMS, current, keyMaker(), BUDGETS)).toEqual([{ kind: "delete-limit", scope: "agent", team: "platform", agent: "gone" }]);
  });
});

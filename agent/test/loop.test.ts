import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Action, actionFor, begin, branchName, type LoopEvent, type LoopState, next, parseImplementCommand } from "../src/loop.ts";

const TARGET = { owner: "acme", repo: "widgets", number: 12 };
const ISSUE = { title: "Add a farewell function", body: "Say goodbye.", comments: [] as string[] };
const ACTION_KINDS = ["read", "ready-check", "commands", "approve", "setup", "build", "test", "pr-branch", "pr-push", "pr-open", "finish", "park", "noop"];

const text = fc.string({ maxLength: 40 });
const eventArb: fc.Arbitrary<LoopEvent> = fc.oneof(
  fc.record({ type: fc.constant("read" as const), issue: fc.record({ title: text, body: text, comments: fc.array(text, { maxLength: 3 }) }), baseBranch: text }),
  fc.record({ type: fc.constant("ready" as const), ready: fc.boolean(), reason: text }),
  fc.record({ type: fc.constant("commands" as const), setup: fc.option(text, { nil: undefined }), test: fc.option(text, { nil: undefined }) }),
  fc.record({ type: fc.constant("approval" as const), approved: fc.boolean(), reason: fc.option(text, { nil: undefined }) }),
  fc.record({ type: fc.constant("setup" as const), ok: fc.boolean(), output: text, timedOut: fc.option(fc.boolean(), { nil: undefined }) }),
  fc.record({ type: fc.constant("built" as const), ok: fc.boolean(), files: fc.array(text, { maxLength: 3 }) }),
  fc.record({ type: fc.constant("tested" as const), green: fc.boolean(), output: fc.oneof(text, fc.constant("")), timedOut: fc.option(fc.boolean(), { nil: undefined }) }),
  fc.constant({ type: "branched" as const }),
  fc.constant({ type: "pushed" as const }),
  fc.record({ type: fc.constant("opened" as const), url: text }),
  fc.record({ type: fc.constant("failed" as const), code: text, reason: text }),
);

/** The event a runner would send back for this action, with a coin for success. */
function eventFor(action: Action, ok: boolean, words: string): LoopEvent | undefined {
  switch (action.kind) {
    case "read": return { type: "read", issue: ISSUE, baseBranch: "main" };
    case "ready-check": return { type: "ready", ready: ok, reason: words };
    case "commands": return { type: "commands", setup: ok ? "npm ci" : undefined, test: "npm test" };
    case "approve": return { type: "approval", approved: ok, reason: words };
    case "setup": return { type: "setup", ok, output: words };
    case "build": return { type: "built", ok, files: ["a.js"] };
    case "test": return { type: "tested", green: ok, output: words };
    case "pr-branch": return { type: "branched" };
    case "pr-push": return { type: "pushed" };
    case "pr-open": return { type: "opened", url: "https://github.com/acme/widgets/pull/1" };
    default: return undefined;
  }
}

const seedArb = fc.record({ junk: eventArb, useJunk: fc.integer({ min: 0, max: 9 }), ok: fc.boolean(), words: text });
const seedsArb = fc.array(seedArb, { maxLength: 40 });
type Seed = { junk: LoopEvent; useJunk: number; ok: boolean; words: string };

/** Runs the machine over seeds: mostly the event each action asks for, sometimes any event at all. */
function drive(seeds: Seed[]) {
  let { state, action } = begin(TARGET);
  const trace: { before: LoopState; event: LoopEvent; after: LoopState; action: Action }[] = [];
  for (const seed of seeds) {
    const event = seed.useJunk < 2 ? seed.junk : (eventFor(action, seed.ok, seed.words) ?? seed.junk);
    const before = state;
    ({ state, action } = next(state, event));
    trace.push({ before, event, after: state, action });
  }
  return trace;
}

describe("the loop step machine", () => {
  it("starts at read with the target's issue", () => {
    const { state, action } = begin(TARGET);
    expect(state.step).toBe("read");
    expect(action).toEqual({ kind: "read" });
  });

  it("walks a ready issue to a pull request, one action per step", () => {
    let { state, action } = begin(TARGET);
    const kinds: string[] = [action.kind];
    for (const event of [
      { type: "read", issue: ISSUE, baseBranch: "main" },
      { type: "ready", ready: true, reason: "clear" },
      { type: "commands", setup: "npm ci", test: "npm test" },
      { type: "approval", approved: true },
      { type: "setup", ok: true, output: "" },
      { type: "built", ok: true, files: ["farewell.js"] },
      { type: "tested", green: true, output: "ok" },
      { type: "branched" },
      { type: "pushed" },
      { type: "opened", url: "https://github.com/acme/widgets/pull/7" },
    ] as LoopEvent[]) {
      ({ state, action } = next(state, event));
      kinds.push(action.kind);
    }
    expect(kinds).toEqual(["read", "ready-check", "commands", "approve", "setup", "build", "test", "pr-branch", "pr-push", "pr-open", "finish"]);
    expect(state.step).toBe("done");
    expect(state.prUrl).toBe("https://github.com/acme/widgets/pull/7");
  });

  it("asks for approval with the exact commands, branch and repo", () => {
    let { state } = begin(TARGET);
    ({ state } = next(state, { type: "read", issue: ISSUE, baseBranch: "main" }));
    ({ state } = next(state, { type: "ready", ready: true, reason: "clear" }));
    const got = next(state, { type: "commands", setup: undefined, test: "node --test" });
    expect(got.action).toEqual({ kind: "approve", setup: undefined, test: "node --test", branch: "implement/12-add-a-farewell-function", repo: "acme/widgets" });
    expect(actionFor(got.state)).toEqual(got.action);
  });

  it("parks a not-ready issue with the reason, and a missing test command", () => {
    let { state } = begin(TARGET);
    ({ state } = next(state, { type: "read", issue: ISSUE, baseBranch: "main" }));
    const notReady = next(state, { type: "ready", ready: false, reason: "no criteria" });
    expect(notReady.action.kind).toBe("park");
    expect(notReady.state.reason).toContain("no criteria");
    const { state: ready } = next(state, { type: "ready", ready: true, reason: "ok" });
    const noTest = next(ready, { type: "commands", setup: "npm ci", test: undefined });
    expect(noTest.action.kind).toBe("park");
    expect(noTest.state.reason).toMatch(/test command/i);
  });

  it("builds branch names as implement/<n>-<slug>", () => {
    expect(branchName(7, "Fix: the  Thing!!")).toBe("implement/7-fix-the-thing");
    expect(branchName(7, "!!!")).toBe("implement/7-issue");
    expect(branchName(7, "x".repeat(200)).length).toBeLessThanOrEqual("implement/7-".length + 40);
  });

  it("never starts the pull request before a green check after the last build", () => {
    fc.assert(
      fc.property(seedsArb, (seeds) => {
        const trace = drive(seeds);
        trace.forEach((t, i) => {
          if (!t.action.kind.startsWith("pr-") || t.before.step === "pr") return;
          // The event that opened the pull request stage is a green test result in the check step.
          expect(t.before.step).toBe("check");
          expect(t.event).toMatchObject({ type: "tested", green: true });
          const events = trace.slice(0, i + 1).map((x) => x.event);
          const lastBuilt = events.map((e) => e.type).lastIndexOf("built");
          expect(events.slice(lastBuilt + 1).some((e) => e.type === "tested" && e.green)).toBe(true);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("gives a legal action or parked for any event in any state", () => {
    fc.assert(
      fc.property(seedsArb, eventArb, (seeds, event) => {
        const trace = drive(seeds);
        const state = trace.at(-1)?.after ?? begin(TARGET).state;
        const got = next(state, event);
        expect(ACTION_KINDS).toContain(got.action.kind);
        expect(got.action).toEqual(actionFor(got.state));
        expect(got.action.kind === "park").toBe(got.state.step === "parked");
        for (const t of trace) expect(ACTION_KINDS).toContain(t.action.kind);
      }),
      { numRuns: 300 },
    );
  });

  it("gives the same next action for a saved and loaded state", () => {
    fc.assert(
      fc.property(seedsArb, eventArb, (seeds, event) => {
        const trace = drive(seeds);
        const state = trace.at(-1)?.after ?? begin(TARGET).state;
        const loaded = JSON.parse(JSON.stringify(state)) as LoopState;
        expect(actionFor(loaded)).toEqual(actionFor(state));
        expect(next(loaded, event)).toEqual(next(state, event));
      }),
      { numRuns: 300 },
    );
  });

  it("keeps a done or parked run where it is", () => {
    let { state } = begin(TARGET);
    ({ state } = next(state, { type: "failed", code: "x", reason: "boom" }));
    expect(state.step).toBe("parked");
    const again = next(state, { type: "read", issue: ISSUE, baseBranch: "main" });
    expect(again.state).toEqual(state);
    expect(again.action.kind).toBe("park");
  });
});

describe("the /implement command", () => {
  it("reads a GitHub issue URL", () => {
    expect(parseImplementCommand("/implement https://github.com/acme/widgets/issues/12")).toEqual({ kind: "start", target: TARGET });
    expect(parseImplementCommand("  /implement   https://github.com/acme/widgets/issues/12/  ")).toEqual({ kind: "start", target: TARGET });
  });

  it("leaves other messages to the model", () => {
    for (const t of ["hello", "please /implement this", "/implementation notes", ""]) expect(parseImplementCommand(t)).toEqual({ kind: "none" });
  });

  it("rejects anything that is not a GitHub issue URL with a usage message", () => {
    for (const t of [
      "/implement",
      "/implement https://github.com/acme/widgets/pull/12",
      "/implement http://github.com/acme/widgets/issues/12",
      "/implement https://evil.example/acme/widgets/issues/12",
      "/implement https://github.com/acme/widgets/issues/abc",
      "/implement https://github.com/acme/../issues/12",
      "/implement https://github.com/acme/widgets/issues/12 extra",
      "/implement https://github.com/acme/widgets/issues/12?x=1",
      "/implement continue",
    ]) {
      const got = parseImplementCommand(t);
      expect(got.kind).toBe("invalid");
      expect((got as { message: string }).message).toContain("/implement https://github.com/<owner>/<repo>/issues/<n>");
    }
  });
});

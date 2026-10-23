import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Action, actionFor, begin, branchName, canContinue, isLockfile, isTestFile, type LoopEvent, type LoopState, next, parseImplementCommand, ROUND_CAP } from "../src/loop.ts";

const TARGET = { owner: "acme", repo: "widgets", number: 12 };
const ISSUE = { title: "Add a farewell function", body: "Say goodbye.", comments: [] as string[] };
const ACTION_KINDS = ["read", "ready-check", "commands", "approve", "setup", "build-tests", "build-code", "test", "review", "pr-branch", "pr-push", "pr-open", "finish", "park", "noop"];

const text = fc.string({ maxLength: 40 });
const findingArb = fc.record({ severity: fc.constantFrom("CRITICAL", "HIGH", "MEDIUM", "LOW"), file: text, reason: text });
const eventArb: fc.Arbitrary<LoopEvent> = fc.oneof(
  fc.record({ type: fc.constant("read" as const), issue: fc.record({ title: text, body: text, comments: fc.array(text, { maxLength: 3 }) }), baseBranch: text }),
  fc.record({ type: fc.constant("ready" as const), ready: fc.boolean(), reason: text }),
  fc.record({ type: fc.constant("commands" as const), setup: fc.option(text, { nil: undefined }), test: fc.option(text, { nil: undefined }) }),
  fc.record({ type: fc.constant("approval" as const), approved: fc.boolean(), reason: fc.option(text, { nil: undefined }) }),
  fc.record({ type: fc.constant("setup" as const), ok: fc.boolean(), output: text, timedOut: fc.option(fc.boolean(), { nil: undefined }) }),
  fc.record({ type: fc.constant("built" as const), ok: fc.boolean(), files: fc.array(text, { maxLength: 3 }) }),
  fc.record({ type: fc.constant("reviewed" as const), findings: fc.array(findingArb, { maxLength: 4 }) }),
  fc.record({ type: fc.constant("tested" as const), green: fc.boolean(), output: fc.oneof(text, fc.constant("")), timedOut: fc.option(fc.boolean(), { nil: undefined }) }),
  fc.constant({ type: "branched" as const }),
  fc.constant({ type: "pushed" as const }),
  fc.record({ type: fc.constant("opened" as const), url: text }),
  fc.record({ type: fc.constant("failed" as const), code: text, reason: text }),
  fc.record({ type: fc.constant("continue" as const), note: fc.option(text, { nil: undefined }) }),
  fc.constant({ type: "stop" as const }),
);

/** The event a runner would send back for this action, with a coin for success. */
function eventFor(action: Action, ok: boolean, words: string): LoopEvent | undefined {
  switch (action.kind) {
    case "read": return { type: "read", issue: ISSUE, baseBranch: "main" };
    case "ready-check": return { type: "ready", ready: ok, reason: words };
    case "commands": return { type: "commands", setup: ok ? "npm ci" : undefined, test: "npm test" };
    case "approve": return { type: "approval", approved: ok, reason: words };
    case "setup": return { type: "setup", ok, output: words };
    case "build-tests": return { type: "built", ok: true, files: ok ? ["test/a.test.js"] : ["a.js"] };
    case "build-code": return { type: "built", ok: true, files: ok ? ["a.js"] : ["package-lock.json"] };
    case "park": return { type: "continue", note: words };
    case "test": return { type: "tested", green: ok, output: words };
    case "review": return { type: "reviewed", findings: ok ? [] : [{ severity: "HIGH", file: "a.js", reason: words }] };
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
      { type: "built", ok: true, files: ["test/farewell.test.js"] },
      { type: "tested", green: false, output: "1 failing" },
      { type: "built", ok: true, files: ["farewell.js"] },
      { type: "tested", green: true, output: "ok" },
      { type: "reviewed", findings: [] },
      { type: "reviewed", findings: [] },
      { type: "branched" },
      { type: "pushed" },
      { type: "opened", url: "https://github.com/acme/widgets/pull/7" },
    ] as LoopEvent[]) {
      ({ state, action } = next(state, event));
      kinds.push(action.kind);
    }
    expect(kinds).toEqual(["read", "ready-check", "commands", "approve", "setup", "build-tests", "test", "build-code", "test", "review", "review", "pr-branch", "pr-push", "pr-open", "finish"]);
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

  it("never starts the pull request before a green check after the last build and a clean review after it", () => {
    fc.assert(
      fc.property(seedsArb, (seeds) => {
        const trace = drive(seeds);
        trace.forEach((t, i) => {
          if (!t.action.kind.startsWith("pr-") || t.before.step === "pr") return;
          // The event that opened the pull request stage is the standards review.
          expect(t.before.step).toBe("review-standards");
          expect(t.event.type).toBe("reviewed");
          const events = trace.slice(0, i + 1).map((x) => x.event);
          const lastBuilt = events.map((e) => e.type).lastIndexOf("built");
          expect(events.slice(lastBuilt + 1).some((e) => e.type === "tested" && e.green)).toBe(true);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("never opens the pull request while a CRITICAL or HIGH finding is open from the last review", () => {
    const isBlocking = (f: { severity: string }) => f.severity === "CRITICAL" || f.severity === "HIGH";
    fc.assert(
      fc.property(seedsArb, (seeds) => {
        const trace = drive(seeds);
        trace.forEach((t, i) => {
          if (!t.action.kind.startsWith("pr-")) return;
          expect((t.after.findings ?? []).some(isBlocking)).toBe(false);
          // Every review since the last build came back without a blocking finding.
          const events = trace.slice(0, i + 1).map((x) => x.event);
          const lastBuilt = events.map((e) => e.type).lastIndexOf("built");
          const reviews = events.slice(lastBuilt + 1).filter((e): e is Extract<LoopEvent, { type: "reviewed" }> => e.type === "reviewed");
          expect(reviews).toHaveLength(2);
          for (const r of reviews) expect(r.findings.some(isBlocking)).toBe(false);
        });
      }),
      { numRuns: 500 },
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
      "/implement stopping",
      "/implement continuous",
    ]) {
      const got = parseImplementCommand(t);
      expect(got.kind).toBe("invalid");
      expect((got as { message: string }).message).toContain("/implement https://github.com/<owner>/<repo>/issues/<n>");
    }
  });

  it("reads continue with and without a note, and stop", () => {
    expect(parseImplementCommand("/implement continue")).toEqual({ kind: "continue" });
    expect(parseImplementCommand("/implement continue fix the off-by-one")).toEqual({ kind: "continue", note: "fix the off-by-one" });
    expect(parseImplementCommand("  /implement   continue   try  harder \n")).toEqual({ kind: "continue", note: "try  harder" });
    expect(parseImplementCommand("/implement stop")).toEqual({ kind: "stop" });
  });
});

/** A run walked through the events a runner sends. */
function runTo(events: LoopEvent[]): { state: LoopState; action: Action } {
  let got = begin(TARGET);
  for (const event of events) got = next(got.state, event);
  return got;
}
const TO_APPROVED: LoopEvent[] = [
  { type: "read", issue: ISSUE, baseBranch: "main" },
  { type: "ready", ready: true, reason: "clear" },
  { type: "commands", setup: "npm ci", test: "npm test" },
  { type: "approval", approved: true },
  { type: "setup", ok: true, output: "" },
];
const TESTS_WRITTEN: LoopEvent = { type: "built", ok: true, files: ["test/a.test.js"] };
const CODE_WRITTEN: LoopEvent = { type: "built", ok: true, files: ["a.js"] };
const RED: LoopEvent = { type: "tested", green: false, output: "1 failing" };
const GREEN: LoopEvent = { type: "tested", green: true, output: "ok" };

describe("test-first build", () => {
  it("runs the tests after the tests are written, and the code only after they are red", () => {
    const afterTests = runTo([...TO_APPROVED, TESTS_WRITTEN]);
    expect(afterTests.state.step).toBe("check-red");
    expect(afterTests.action).toEqual({ kind: "test" });
    const afterRed = next(afterTests.state, RED);
    expect(afterRed.state.step).toBe("build-code");
    expect(afterRed.state.round).toBe(1);
    expect(afterRed.state.testOutput).toBe("1 failing");
    expect(next(afterRed.state, CODE_WRITTEN).state.step).toBe("check-green");
  });

  it("sends tests that pass at once back to the tests step with that fact, in the next round", () => {
    const got = next(runTo([...TO_APPROVED, TESTS_WRITTEN]).state, GREEN);
    expect(got.state.step).toBe("build-tests");
    expect(got.state.round).toBe(2);
    expect(got.state.feedback).toMatch(/passed before any code/i);
    expect(got.action.kind).toBe("build-tests");
  });

  it("treats a non-test file written with the tests as a protocol error for the round", () => {
    const got = next(runTo(TO_APPROVED).state, { type: "built", ok: true, files: ["test/a.test.js", "src/feature.js"] });
    expect(got.state.step).toBe("build-tests");
    expect(got.state.round).toBe(2);
    expect(got.state.feedback).toContain("src/feature.js");
    expect(got.state.feedback).toMatch(/protocol error/i);
  });

  it("sends red after the code back to the code step with the test output", () => {
    const checked = runTo([...TO_APPROVED, TESTS_WRITTEN, RED, CODE_WRITTEN]).state;
    const got = next(checked, { type: "tested", green: false, output: "still 1 failing" });
    expect(got.state.step).toBe("build-code");
    expect(got.state.round).toBe(2);
    expect(got.state.testOutput).toBe("still 1 failing");
  });

  it("parks at the cap with the reason, and continue gives it three more rounds and the note", () => {
    let got = runTo([...TO_APPROVED, TESTS_WRITTEN, RED]);
    for (let round = 1; round < ROUND_CAP; round++) got = next(next(got.state, CODE_WRITTEN).state, RED);
    expect(got.state.step).toBe("build-code");
    expect(got.state.round).toBe(ROUND_CAP);
    const parked = next(next(got.state, CODE_WRITTEN).state, RED);
    expect(parked.action.kind).toBe("park");
    expect(parked.state.round).toBe(ROUND_CAP);
    expect(parked.state.reason).toMatch(/3 rounds/);
    expect(canContinue(parked.state)).toBe(true);

    const resumed = next(parked.state, { type: "continue", note: "fix the off-by-one" });
    expect(resumed.state.step).toBe("build-code");
    expect(resumed.state.round).toBe(ROUND_CAP + 1);
    expect(resumed.state.note).toBe("fix the off-by-one");
    expect(resumed.state.cap).toBe(2 * ROUND_CAP);
  });

  it("cannot continue a run that parked before the build", () => {
    const parked = runTo([{ type: "read", issue: ISSUE, baseBranch: "main" }, { type: "ready", ready: false, reason: "thin" }]);
    expect(canContinue(parked.state)).toBe(false);
    expect(next(parked.state, { type: "continue" }).state).toEqual(parked.state);
  });

  it("stops a run at any step but done", () => {
    expect(next(runTo(TO_APPROVED).state, { type: "stop" }).state.step).toBe("stopped");
    expect(next(runTo([{ type: "failed", code: "x", reason: "boom" }]).state, { type: "stop" }).state.step).toBe("stopped");
  });

  it("runs setup again, then the check, when the code step changes a lockfile and a setup command was approved", () => {
    const inCode = runTo([...TO_APPROVED, TESTS_WRITTEN, RED]).state;
    const got = next(inCode, { type: "built", ok: true, files: ["a.js", "package-lock.json"] });
    expect(got.action.kind).toBe("setup");
    expect(next(got.state, { type: "setup", ok: true, output: "" }).state.step).toBe("check-green");
    const noSetup = runTo([...TO_APPROVED.slice(0, 2), { type: "commands", setup: undefined, test: "t" }, { type: "approval", approved: true }, TESTS_WRITTEN, RED]);
    expect(next(noSetup.state, { type: "built", ok: true, files: ["package-lock.json"] }).state.step).toBe("check-green");
  });

  it("knows test files and lockfiles", () => {
    for (const f of ["test/a.js", "tests/x/y.py", "src/__tests__/a.ts", "a.test.js", "a_test.go", "test_a.py", "a.spec.ts"]) expect(isTestFile(f)).toBe(true);
    for (const f of ["src/a.js", "latest.js", "contest/a.js", "package.json", "src/protest.ts"]) expect(isTestFile(f)).toBe(false);
    for (const f of ["package-lock.json", "web/pnpm-lock.yaml", "go.sum"]) expect(isLockfile(f)).toBe(true);
    expect(isLockfile("package.json")).toBe(false);
  });

  it("never starts build-code before a red check-red", () => {
    // Positive side: after the tests are written the run waits in check-red, and only a red result (any output) opens build-code.
    fc.assert(
      fc.property(text, fc.boolean(), (output, green) => {
        const atCheck = runTo([...TO_APPROVED, TESTS_WRITTEN]);
        expect(atCheck.state.step).toBe("check-red");
        expect(atCheck.action.kind).toBe("test");
        const got = next(atCheck.state, { type: "tested", green, output });
        expect(got.state.step).toBe(green ? "build-tests" : "build-code");
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(seedsArb, (seeds) => {
        const trace = drive(seeds);
        trace.forEach((t, i) => {
          if (t.after.step !== "build-code") return;
          expect(trace.slice(0, i + 1).some((x) => x.before.step === "check-red" && x.after.step === "build-code" && x.event.type === "tested" && !x.event.green)).toBe(true);
        });
      }),
      { numRuns: 500 },
    );
  });

  it("never lets the round count pass the cap (3, plus 3 per continue)", () => {
    fc.assert(
      fc.property(seedsArb, (seeds) => {
        const trace = drive(seeds);
        let continues = 0;
        for (const t of trace) {
          if (t.before.step === "parked" && t.after.step !== "parked" && t.event.type === "continue") continues++;
          expect(t.after.round).toBeLessThanOrEqual(ROUND_CAP * (1 + continues));
          expect(t.after.round).toBeLessThanOrEqual(t.after.cap);
          expect(t.after.cap).toBe(ROUND_CAP * (1 + continues));
        }
      }),
      { numRuns: 500 },
    );
  });
});

const REVIEWED_CLEAN: LoopEvent = { type: "reviewed", findings: [] };
const HIGH = { severity: "HIGH", file: "a.js", reason: "does not handle empty names" } as const;
const LOW = { severity: "LOW", file: "a.js", reason: "name is vague" } as const;
const TO_REVIEW: LoopEvent[] = [...TO_APPROVED, TESTS_WRITTEN, RED, CODE_WRITTEN, GREEN];

describe("two-axis review", () => {
  it("reviews spec, then standards, after a green check, and opens the pull request when both are clean", () => {
    const atSpec = runTo(TO_REVIEW);
    expect(atSpec.state.step).toBe("review-spec");
    expect(atSpec.action).toEqual({ kind: "review", axis: "spec" });
    const atStandards = next(atSpec.state, REVIEWED_CLEAN);
    expect(atStandards.action).toEqual({ kind: "review", axis: "standards" });
    expect(next(atStandards.state, REVIEWED_CLEAN).action.kind).toBe("pr-branch");
  });

  it("sends a CRITICAL or HIGH finding back to the code step with the findings, in the next round", () => {
    const atStandards = next(runTo(TO_REVIEW).state, { type: "reviewed", findings: [HIGH] });
    const got = next(atStandards.state, REVIEWED_CLEAN);
    expect(got.state.step).toBe("build-code");
    expect(got.state.round).toBe(2);
    expect(got.state.feedback).toContain("does not handle empty names");
    expect(got.state.feedback).toContain("HIGH");
    expect(got.state.feedback).toContain("a.js");
    expect(got.action.kind).toBe("build-code");
  });

  it("keeps MEDIUM and LOW findings for the pull request and does not block on them", () => {
    const atStandards = next(runTo(TO_REVIEW).state, { type: "reviewed", findings: [LOW] });
    const got = next(atStandards.state, { type: "reviewed", findings: [{ severity: "MEDIUM", file: "b.js", reason: "long function" }] });
    expect(got.action.kind).toBe("pr-branch");
    expect(got.state.findings?.map((f) => f.severity).sort()).toEqual(["LOW", "MEDIUM"]);
  });

  it("parks at the cap with the findings still open, and a fix round after continue starts from the code step", () => {
    let got = runTo(TO_REVIEW);
    for (let round = 1; round < ROUND_CAP; round++) {
      got = next(next(got.state, { type: "reviewed", findings: [HIGH] }).state, REVIEWED_CLEAN);
      got = next(next(got.state, CODE_WRITTEN).state, GREEN);
    }
    expect(got.state.round).toBe(ROUND_CAP);
    const parked = next(next(got.state, { type: "reviewed", findings: [HIGH] }).state, REVIEWED_CLEAN);
    expect(parked.action.kind).toBe("park");
    expect(parked.state.findings).toEqual([HIGH]);
    expect(parked.state.reason).toMatch(/3 rounds/);
    expect(canContinue(parked.state)).toBe(true);
    expect(next(parked.state, { type: "continue" }).state.step).toBe("build-code");
  });

  it("parks a run whose review failed, and cannot continue it", () => {
    const parked = next(runTo(TO_REVIEW).state, { type: "failed", code: "review-invalid", reason: "bad json" });
    expect(parked.action.kind).toBe("park");
    expect(canContinue(parked.state)).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeController, SESSION_ID, startFakeController } from "./fake-controller.ts";
import { type FakeMcp, startFakeMcp } from "./fake-mcp.ts";
import { type FakeModel, type RunningAgent, readyzStatus, type ScriptedReply, startAgent, startFakeModel, streamMessage, waitFor, writeFakeConfig } from "./helpers.ts";
import { sendTurn, type Turn } from "./hitl-client.ts";

let agent: RunningAgent | undefined;
let controller: FakeController | undefined;
let model: FakeModel | undefined;
let mcp: FakeMcp | undefined;
afterEach(async () => {
  await agent?.stop();
  await controller?.close();
  await model?.close();
  await mcp?.close();
  agent = controller = model = mcp = undefined;
});

const ISSUE_URL = "https://github.com/acme/widgets/issues/12";
const IMPLEMENT = `/implement ${ISSUE_URL}`;
const PR_URL = "https://github.com/acme/widgets/pull/34";
const BRANCH = "implement/12-add-a-farewell-file";
const SENTINELS = ["SENTINEL-ISSUE-BODY", "SENTINEL-ISSUE-COMMENT", "SENTINEL-FILE-CONTENT", "SENTINEL-TEST-OUTPUT"];

const SUB_AGENTS = [
  { name: "explorer", description: "read-only", instruction: "You explore.", model: { model: "cheap-model" }, stream: false },
  { name: "executor", description: "full tools", instruction: "You execute.", model: { model: "strong-model" }, stream: false },
];
const READY: ScriptedReply = '{"ready": true, "reason": "says what to build and how to test it"}';
const write = (path: string, content: string): ScriptedReply => ({ toolCall: { name: "write_file", args: { path, content } } });
const PASSING_REPO = {
  "AGENTS.md": "# Rules\n- Setup: `touch setup.marker`\n- Test: `sh test.sh`\n",
  // Runs every test/*.test.sh: red until one exists and passes.
  "test.sh": 'echo SENTINEL-TEST-OUTPUT\nfor t in test/*.test.sh; do sh "$t" || exit 1; done\n',
};
/** The executor's tests step: a test that needs feature.txt. */
const TESTS_STEP: ScriptedReply[] = [write("test/feature.test.sh", "test -f feature.txt\n"), "Wrote the test."];
/** The executor's code step: the feature. */
const CODE_STEP: ScriptedReply[] = [write("feature.txt", "SENTINEL-FILE-CONTENT\n"), "Wrote feature.txt."];
/** A code step that leaves the tests red. */
const WRONG_CODE: ScriptedReply[] = [write("wrong.txt", "nope\n"), "Wrote wrong.txt."];
/** A happy-path script: ready check, tests, then code. */
const HAPPY: ScriptedReply[] = [READY, ...TESTS_STEP, ...CODE_STEP];

/** A repo served over file://, where https://github.com/<owner>/<repo>.git would be. */
function makeGitHost(owner: string, repo: string, files: Record<string, string>): string {
  const host = mkdtempSync(join(tmpdir(), "git-host-"));
  const dir = join(host, owner, `${repo}.git`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return `file://${host}`;
}

const tools = [
  {
    name: "issue_read",
    description: "Read an issue",
    result: (args: { method: string }) =>
      args.method === "get_comments"
        ? JSON.stringify([{ body: "SENTINEL-ISSUE-COMMENT: also handle empty names", user: { login: "dackota" } }])
        : JSON.stringify({ number: 12, title: "Add a farewell file", body: "SENTINEL-ISSUE-BODY: add feature.txt. Done when test.sh passes." }),
  },
  { name: "create_branch", description: "Create a branch", result: '{"ref":"refs/heads/x"}' },
  { name: "push_files", description: "Push files", result: '{"sha":"abc"}' },
  { name: "create_pull_request", description: "Open a pull request", result: JSON.stringify({ id: 34, url: PR_URL }) },
];

type BootOptions = { files?: Record<string, string>; env?: Record<string, string> };

async function boot(script: ScriptedReply[], opts: BootOptions = {}) {
  model = await startFakeModel(script);
  controller = await startFakeController();
  mcp = await startFakeMcp(tools);
  const gitBase = makeGitHost("acme", "widgets", opts.files ?? PASSING_REPO);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  const identity = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(identity, `session-${SESSION_ID}\n`);
  const httpTools = [{ params: { url: mcp.url, headers: {} }, tools: ["create_branch", "push_files", "create_pull_request"], require_approval: true }];
  const configPath = writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url, httpTools, subAgents: SUB_AGENTS });
  const start = async () => {
    agent = await startAgent(configPath, { AGENT_DATA_DIR: dataDir, KAGENT_IDENTITY_PATH: identity, AGENT_GIT_BASE_URL: gitBase, ...opts.env });
    await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  };
  await start();
  const contextId = `ctx-${crypto.randomUUID()}`;
  return {
    dataDir,
    contextId,
    workspace: join(dataDir, "workspaces", contextId),
    restart: async () => {
      await agent!.stop();
      await start();
    },
  };
}

async function turn(opts: Parameters<typeof sendTurn>[1]): Promise<Turn> {
  const got = await waitFor(async () => {
    try {
      return await sendTurn(agent!.grpcPort, opts);
    } catch {
      return null;
    }
  });
  if (!got) throw new Error("no reply from the agent");
  return got;
}

const approve = (paused: Turn, contextId: string) =>
  turn({ text: "approve", taskId: paused.taskId, contextId, approvals: [{ id: paused.approvalRequest!.tools[0]!.id, approved: true }] });
const calledTools = () => mcp!.calls.map((c) => c.name);
/** The request bodies of the executor subagent's model calls, in order. */
const executorBodies = () => model!.requests.map((r) => r.body).filter((b) => b.includes("strong-model"));
const loopLines = () =>
  agent!
    .output()
    .split("\n")
    .filter((l) => l.includes('"event":"loop-step"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("/implement on a ready issue", () => {
  it("turns a ready issue into a pull request", async () => {
    const { contextId, workspace } = await boot(HAPPY);

    const paused = await turn({ text: IMPLEMENT, contextId });
    expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const done = await approve(paused, contextId);

    expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(done.text).toBe(PR_URL);
    expect(calledTools().filter((n) => n !== "issue_read")).toEqual(["create_branch", "push_files", "create_pull_request"]);
    expect(existsSync(join(workspace, "setup.marker"))).toBe(true);
    const byName = (name: string) => mcp!.calls.find((c) => c.name === name)!.args as Record<string, any>;
    expect(byName("create_branch")).toMatchObject({ owner: "acme", repo: "widgets", branch: BRANCH });
    expect(byName("push_files")).toMatchObject({ owner: "acme", repo: "widgets", branch: BRANCH });
    expect(byName("push_files").files).toEqual([
      { path: "feature.txt", content: "SENTINEL-FILE-CONTENT\n" },
      { path: "test/feature.test.sh", content: "test -f feature.txt\n" },
    ]);
    expect(calledTools().filter((n) => n === "create_pull_request")).toHaveLength(1);
    // The tests came first: the first executor prompt asks for tests only, the second for code.
    const executorPrompts = executorBodies();
    expect(executorPrompts[0]).toMatch(/ONLY the tests/);
    expect(executorPrompts.at(-1)).toMatch(/Write the code that makes them pass/);
    const pr = byName("create_pull_request");
    expect(pr).toMatchObject({ owner: "acme", repo: "widgets", head: BRANCH, base: "main" });
    expect(pr.body).toContain(ISSUE_URL);
    expect(pr.body).toContain("sh test.sh");
    expect(pr.body.trimEnd().endsWith("Closes #12")).toBe(true);
    // The explorer saw the issue, comments included; the main model was never called.
    const explorerRequest = model!.requests.map((r) => r.body).find((b) => b.includes("cheap-model"))!;
    expect(explorerRequest).toContain("SENTINEL-ISSUE-COMMENT");
  });

  it("shows the exact commands, branch and repo in the start approval", async () => {
    const { contextId } = await boot(HAPPY);

    const paused = await turn({ text: IMPLEMENT, contextId });

    expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const request = paused.approvalRequest!;
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0]!.args).toEqual({ repo: "acme/widgets", branch: BRANCH, setup: "touch setup.marker", test: "sh test.sh" });
    for (const exact of ["touch setup.marker", "sh test.sh", BRANCH, "acme/widgets"]) expect(request.hint).toContain(exact);
    expect(calledTools()).not.toContain("create_branch");
  });

  it("ends the run without a branch when the start approval is denied", async () => {
    const { contextId } = await boot(HAPPY);
    const paused = await turn({ text: IMPLEMENT, contextId });

    const done = await turn({ text: "deny", taskId: paused.taskId, contextId, approvals: [{ id: paused.approvalRequest!.tools[0]!.id, approved: false, rejection_reason: "wrong repo" }] });

    expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(done.text).toContain("wrong repo");
    expect(calledTools()).not.toContain("create_branch");
    expect(calledTools()).not.toContain("create_pull_request");
    expect(model!.requests).toHaveLength(1);
  });

  it("publishes a progress message for each step", async () => {
    const { contextId } = await boot(HAPPY);

    const events = await streamMessage(agent!.grpcPort, IMPLEMENT, { contextId });

    const steps = events.filter((e) => e.event?.type === "loop_step").map((e) => e.event!.step);
    expect(steps).toEqual(["read", "ready-check", "commands"]);
    expect(events.at(-1)?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  });

  it("logs loop-step lines with no test output, file content or issue text", async () => {
    const { contextId } = await boot(HAPPY);
    const paused = await turn({ text: IMPLEMENT, contextId });
    await approve(paused, contextId);

    const lines = loopLines();

    expect(lines.map((l) => l.step)).toEqual(["read", "ready-check", "commands", "approve", "setup", "build-tests", "check-red", "build-code", "check-green", "pr", "pr", "pr"]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(["event", "result", "round", "step", "t", "taskId"]);
      expect(line.round).toBe(1);
    }
    for (const sentinel of SENTINELS) expect(agent!.output()).not.toContain(sentinel);
  });

  it("goes on after a cold wake between the start approval and the pull request with one pull request", async () => {
    const booted = await boot(HAPPY);
    const { contextId } = booted;
    const paused = await turn({ text: IMPLEMENT, contextId });
    const id = paused.approvalRequest!.tools[0]!.id;

    await booted.restart();
    const again = await turn({ text: "still waiting?", taskId: paused.taskId, contextId });
    const done = await approve(paused, contextId);

    expect(again.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(again.approvalRequest!.tools[0]!.id).toBe(id);
    expect(again.approvalRequest!.tools[0]!.args).toEqual(paused.approvalRequest!.tools[0]!.args);
    expect(done.text).toBe(PR_URL);
    expect(calledTools().filter((n) => n === "create_pull_request")).toHaveLength(1);
    expect(calledTools().filter((n) => n === "create_branch")).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(booted.dataDir, "sessions", contextId, "state.json"), "utf8")) as { loop: { step: string }; pending?: unknown };
    expect(state.loop.step).toBe("done");
    expect(state.pending).toBeUndefined();
  });
});

describe("/implement that parks", () => {
  it("parks a not-ready issue with the reason", async () => {
    const { contextId } = await boot(['{"ready": false, "reason": "no acceptance criteria"}']);

    const got = await turn({ text: IMPLEMENT, contextId });

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.text).toMatch(/parked/i);
    expect(got.text).toContain("no acceptance criteria");
    expect(calledTools()).not.toContain("create_branch");
  });

  it("parks a repo with no test command", async () => {
    const { contextId } = await boot([READY], { files: { "README.md": "# widgets\n" } });

    const got = await turn({ text: IMPLEMENT, contextId });

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.text).toMatch(/parked/i);
    expect(got.text).toMatch(/test command/i);
    expect(calledTools()).not.toContain("create_branch");
  });

  it("parks on a red test result", async () => {
    const { contextId } = await boot(HAPPY, { files: { ...PASSING_REPO, "test.sh": "echo 1 failing\nexit 1\n" } });
    const paused = await turn({ text: IMPLEMENT, contextId });

    const got = await approve(paused, contextId);

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.text).toMatch(/parked/i);
    expect(got.text).toContain("1 failing");
    expect(calledTools()).not.toContain("create_branch");
  });

  it("parks when a loop command runs past its timeout", async () => {
    const { contextId } = await boot(HAPPY, { files: { ...PASSING_REPO, "AGENTS.md": "- Test: `sleep 30`\n" }, env: { AGENT_LOOP_TIMEOUT_MS: "400" } });
    const paused = await turn({ text: IMPLEMENT, contextId });

    const started = Date.now();
    const got = await approve(paused, contextId);

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(got.text).toMatch(/parked/i);
    expect(got.text).toMatch(/timed out/i);
    expect(calledTools()).not.toContain("create_branch");
  });
});

describe("/implement commands", () => {
  it("answers a malformed URL with usage and makes no model call", async () => {
    const { contextId } = await boot(HAPPY);

    const got = await turn({ text: "/implement https://github.com/acme/widgets/pull/12", contextId });

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.text).toContain("/implement https://github.com/<owner>/<repo>/issues/<n>");
    expect(model!.requests).toHaveLength(0);
    expect(mcp!.calls).toEqual([]);
  });

  it("refuses a second /implement while a run is open", async () => {
    const { contextId } = await boot(HAPPY);
    const paused = await turn({ text: IMPLEMENT, contextId });
    const requestsBefore = model!.requests.length;

    const second = await turn({ text: "/implement https://github.com/acme/widgets/issues/99", contextId });

    expect(second.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(second.text).toMatch(/already/i);
    expect(model!.requests).toHaveLength(requestsBefore);
    // The first run still waits for its answer.
    const done = await approve(paused, contextId);
    expect(done.text).toBe(PR_URL);
  });
});

const SETUP_REPO = { ...PASSING_REPO, "AGENTS.md": "- Setup: `echo ran >> setup.log`\n- Test: `sh test.sh`\n" };
/** Three code rounds that stay red (the last text reply repeats for any further call). */
const THREE_RED: ScriptedReply[] = [READY, ...TESTS_STEP, ...WRONG_CODE, "Still wrong.", "Still wrong."];

describe("test-first rounds", () => {
  it("sends tests that pass at once back to the executor, and says so in the next prompt", async () => {
    const { contextId } = await boot([READY, write("test/feature.test.sh", "true\n"), "Wrote a test.", ...TESTS_STEP, ...CODE_STEP]);
    const paused = await turn({ text: IMPLEMENT, contextId });

    const done = await approve(paused, contextId);

    expect(done.text).toBe(PR_URL);
    const prompts = executorBodies();
    expect(prompts[0]).not.toContain("passed before any code");
    expect(prompts.some((b) => b.includes("passed before any code") && b.includes("fails for the right reason") === false && b.includes("fail for the right reason"))).toBe(true);
    expect(calledTools().filter((n) => n === "create_pull_request")).toHaveLength(1);
  });

  it("sends back a non-test file written with the tests", async () => {
    const { contextId } = await boot([READY, write("feature.txt", "early\n"), "Wrote it.", ...TESTS_STEP, ...CODE_STEP]);
    const paused = await turn({ text: IMPLEMENT, contextId });

    const done = await approve(paused, contextId);

    expect(done.text).toBe(PR_URL);
    expect(executorBodies().some((b) => b.includes("Protocol error") && b.includes("feature.txt"))).toBe(true);
    expect(mcp!.calls.find((c) => c.name === "push_files")!.args as { files: { path: string; content: string }[] }).toMatchObject({
      files: expect.arrayContaining([{ path: "feature.txt", content: "SENTINEL-FILE-CONTENT\n" }]),
    });
  });

  it("goes back to the executor on red after the code, then opens the pull request on green", async () => {
    const { contextId } = await boot([READY, ...TESTS_STEP, ...WRONG_CODE, ...CODE_STEP]);
    const paused = await turn({ text: IMPLEMENT, contextId });

    const done = await approve(paused, contextId);

    expect(done.text).toBe(PR_URL);
    expect(executorBodies().some((b) => b.includes("still fail after your code") && b.includes("SENTINEL-TEST-OUTPUT"))).toBe(true);
    expect(calledTools().filter((n) => n === "create_pull_request")).toHaveLength(1);
    expect(loopLines().filter((l) => l.step === "build-code").map((l) => l.round)).toEqual([1, 2]);
  });

  it("parks after three red rounds with the reason and the last test output, and makes no branch", async () => {
    const { contextId } = await boot(THREE_RED);
    const paused = await turn({ text: IMPLEMENT, contextId });

    const got = await approve(paused, contextId);

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.text).toMatch(/parked/i);
    expect(got.text).toMatch(/3 rounds/);
    expect(got.text).toContain("SENTINEL-TEST-OUTPUT");
    expect(calledTools()).not.toContain("create_branch");
  });

  it("continue gives a parked run three more rounds and puts the note in the next executor prompt", async () => {
    const { contextId } = await boot([...THREE_RED, ...CODE_STEP]);
    const paused = await turn({ text: IMPLEMENT, contextId });
    const parked = await approve(paused, contextId);
    expect(parked.text).toMatch(/parked/i);
    const before = executorBodies().length;

    const done = await turn({ text: "/implement continue fix the off-by-one", contextId });

    expect(done.text).toBe(PR_URL);
    const after = executorBodies().slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((b) => b.includes("fix the off-by-one"))).toBe(true);
    expect(executorBodies().slice(0, before).some((b) => b.includes("fix the off-by-one"))).toBe(false);
    expect(loopLines().filter((l) => l.step === "build-code").map((l) => l.round)).toEqual([1, 2, 3, 4]);
  });

  it("parks again after six rounds when continue does not help", async () => {
    const { contextId } = await boot(THREE_RED);
    const paused = await turn({ text: IMPLEMENT, contextId });
    await approve(paused, contextId);

    const got = await turn({ text: "/implement continue", contextId });

    expect(got.text).toMatch(/parked/i);
    expect(got.text).toMatch(/6 rounds/);
    expect(loopLines().filter((l) => l.step === "build-code").map((l) => l.round)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calledTools()).not.toContain("create_branch");
  });

  it("says there is nothing to continue when no run is parked", async () => {
    const { contextId } = await boot(HAPPY);

    const got = await turn({ text: "/implement continue", contextId });

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.text).toMatch(/no parked run/i);
    expect(model!.requests).toHaveLength(0);
  });

  it("stop drops a parked run so a new /implement starts", async () => {
    const { contextId } = await boot([...THREE_RED, READY]);
    const paused = await turn({ text: IMPLEMENT, contextId });
    await approve(paused, contextId);

    const refused = await turn({ text: IMPLEMENT, contextId });
    const stopped = await turn({ text: "/implement stop", contextId });
    const started = await turn({ text: IMPLEMENT, contextId });

    expect(refused.text).toMatch(/already/i);
    expect(refused.text).toMatch(/parked/i);
    expect(stopped.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(stopped.text).toMatch(/stopped/i);
    expect(started.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(started.approvalRequest).toBeDefined();
  });

  it("runs setup once when no lockfile changes across rounds", async () => {
    const { contextId, workspace } = await boot([READY, ...TESTS_STEP, ...WRONG_CODE, ...CODE_STEP], { files: SETUP_REPO });
    const paused = await turn({ text: IMPLEMENT, contextId });

    const done = await approve(paused, contextId);

    expect(done.text).toBe(PR_URL);
    expect(readFileSync(join(workspace, "setup.log"), "utf8").trim().split("\n")).toEqual(["ran"]);
  });

  it("runs setup again when the executor changes the lockfile", async () => {
    const lockfileCode: ScriptedReply[] = [write("feature.txt", "SENTINEL-FILE-CONTENT\n"), write("package-lock.json", "{}\n"), "Wrote feature and lockfile."];
    const { contextId, workspace } = await boot([READY, ...TESTS_STEP, ...lockfileCode], { files: SETUP_REPO });
    const paused = await turn({ text: IMPLEMENT, contextId });

    const done = await approve(paused, contextId);

    expect(done.text).toBe(PR_URL);
    expect(readFileSync(join(workspace, "setup.log"), "utf8").trim().split("\n")).toEqual(["ran", "ran"]);
  });
});

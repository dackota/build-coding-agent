import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import {
  type FakeModel,
  type RunningAgent,
  type ScriptedReply,
  readyzStatus,
  sendTaskWhenUp,
  startAgent,
  startFakeModel,
  toolResults,
  waitFor,
  writeFakeConfig,
} from "./helpers.ts";

const GREET = "function foo() {\n  return 1;\n}\n\nconsole.log(foo());\n";
const DONE = "Done.";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

async function boot(script: ScriptedReply[], env: Record<string, string> = {}): Promise<{ dataDir: string }> {
  model = await startFakeModel(script);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_DATA_DIR: dataDir, ...env });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  return { dataDir };
}

const call = (name: string, args: unknown): ScriptedReply => ({ toolCall: { name, args } });
const workspace = (dataDir: string, contextId: string) => join(dataDir, "workspaces", contextId);

it("read_file shows the model a file sent in the message", async () => {
  await boot([call("read_file", { path: "greet.js" }), DONE]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "What does greet.js print?", { "greet.js": GREET });

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(got.artifacts.reply).toBe(DONE);
  expect(toolResults(model!)[0]).toContain("console.log(foo());");
  // Reading changes nothing, so there is no diff.
  expect(got.artifacts.diff).toBeUndefined();
});

it("write_file creates a file in the workspace and the reply carries its diff", async () => {
  const { dataDir } = await boot([call("write_file", { path: "src/hello.js", content: "console.log('hi');\n" }), DONE]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "Add a hello script");

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(got.artifacts.diff).toBe("--- /dev/null\n+++ b/src/hello.js\n@@ -0,0 +1,1 @@\n+console.log('hi');\n");
  expect(readFileSync(join(workspace(dataDir, got.contextId), "src", "hello.js"), "utf8")).toBe("console.log('hi');\n");
});

it("edit_file renames foo to bar and the reply is a unified diff of that change only", async () => {
  const { dataDir } = await boot([
    call("edit_file", { path: "greet.js", old_string: "function foo()", new_string: "function bar()" }),
    call("edit_file", { path: "greet.js", old_string: "console.log(foo())", new_string: "console.log(bar())" }),
    DONE,
  ]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "rename function foo to bar", { "greet.js": GREET, "other.js": "foo();\n" });

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(got.artifacts.diff).toBe(
    "--- a/greet.js\n+++ b/greet.js\n@@ -1,5 +1,5 @@\n-function foo() {\n+function bar() {\n   return 1;\n }\n \n-console.log(foo());\n+console.log(bar());\n",
  );
  const dir = workspace(dataDir, got.contextId);
  expect(readFileSync(join(dir, "greet.js"), "utf8")).toBe("function bar() {\n  return 1;\n}\n\nconsole.log(bar());\n");
  expect(readFileSync(join(dir, "other.js"), "utf8")).toBe("foo();\n");
});

it("edit_file returns an error to the model when the old text is missing or not unique", async () => {
  const { dataDir } = await boot([
    call("edit_file", { path: "greet.js", old_string: "function baz()", new_string: "x" }),
    call("edit_file", { path: "greet.js", old_string: "foo()", new_string: "bar()" }),
    DONE,
  ]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "rename", { "greet.js": GREET });

  const [missing, ambiguous] = toolResults(model!);
  expect(missing).toMatch(/not found/i);
  expect(ambiguous).toMatch(/2 times|not unique/i);
  expect(got.artifacts.diff).toBeUndefined();
  expect(readFileSync(join(workspace(dataDir, got.contextId), "greet.js"), "utf8")).toBe(GREET);
});

it("search returns path:line matches to the model", async () => {
  await boot([call("search", { pattern: "foo(" }), DONE]);

  await sendTaskWhenUp(agent!.grpcPort, "where is foo called?", { "greet.js": GREET, "lib/other.js": "x();\nfoo();\n" });

  const [found] = toolResults(model!);
  expect(found).toContain("greet.js:1:function foo() {");
  expect(found).toContain("greet.js:5:console.log(foo());");
  expect(found).toContain("lib/other.js:2:foo();");
  expect(found).not.toContain("x();");
});

it("a path outside the workspace returns an error to the model and changes nothing outside", async () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
  const { dataDir } = await boot([
    call("read_file", { path: "../x" }),
    call("write_file", { path: join(outside, "planted.txt"), content: "PWNED" }),
    call("read_file", { path: "link-out/secret.txt" }),
    call("write_file", { path: "link-out/planted.txt", content: "PWNED" }),
    call("edit_file", { path: "../../secret.txt", old_string: "a", new_string: "b" }),
    DONE,
  ]);
  // A symlink out, planted in the workspace of a context the test picks.
  const contextId = "ctx-escape";
  const ws = workspace(dataDir, contextId);
  mkdirSync(ws, { recursive: true });
  symlinkSync(outside, join(ws, "link-out"));

  const got = await sendTaskWhenUp(agent!.grpcPort, "try to escape", {}, contextId);

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  const results = toolResults(model!);
  expect(results).toHaveLength(5);
  for (const r of results) expect(r).toMatch(/outside the workspace/i);
  expect(results.join("\n")).not.toContain("TOP-SECRET");
  expect(readdirSync(outside)).toEqual(["secret.txt"]);
  expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET");
  expect(existsSync(join(dataDir, "workspaces", "x"))).toBe(false);
  expect(got.artifacts.diff).toBeUndefined();
});

it("with the in-memory sandbox the diff comes back and the disk is untouched", async () => {
  const { dataDir } = await boot(
    [call("edit_file", { path: "greet.js", old_string: "return 1;", new_string: "return 2;" }), DONE],
    { AGENT_SANDBOX: "memory" },
  );

  const got = await sendTaskWhenUp(agent!.grpcPort, "return 2", { "greet.js": GREET });

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(got.artifacts.diff).toBe(
    "--- a/greet.js\n+++ b/greet.js\n@@ -1,5 +1,5 @@\n function foo() {\n-  return 1;\n+  return 2;\n }\n \n console.log(foo());\n",
  );
  // Copy-on-write: nothing of this turn reached the real workspace directory.
  const ws = workspace(dataDir, got.contextId);
  expect(existsSync(join(ws, "greet.js"))).toBe(false);
});

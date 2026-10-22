import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalSandbox } from "../src/local-sandbox.ts";
import { type ExecResult, type Sandbox, withHooks } from "../src/sandbox.ts";

/** A bare sandbox that records its calls; `result` is what exec returns. */
function fakeSandbox(calls: string[], result: ExecResult = { stdout: "", stderr: "", exitCode: 0 }): Sandbox {
  return {
    async readFile() {
      calls.push("readFile");
      return "";
    },
    async writeFile() {
      calls.push("writeFile");
    },
    async exec() {
      calls.push("exec");
      return result;
    },
    async stop() {
      calls.push("stop");
    },
  };
}

describe("sandbox lifecycle hooks", () => {
  it("runs afterStart once, before the sandbox is used", async () => {
    const calls: string[] = [];
    const sandbox = await withHooks(fakeSandbox(calls), { afterStart: async () => void calls.push("afterStart") });
    await sandbox.exec("true");
    await sandbox.readFile("a");
    expect(calls).toEqual(["afterStart", "exec", "readFile"]);
  });

  it("runs beforeStop once, before the sandbox stops, however often stop is called", async () => {
    const calls: string[] = [];
    const sandbox = await withHooks(fakeSandbox(calls), { beforeStop: async () => void calls.push("beforeStop") });
    await Promise.all([sandbox.stop(), sandbox.stop()]);
    await sandbox.stop();
    expect(calls).toEqual(["beforeStop", "stop"]);
  });

  it("still stops the sandbox when beforeStop throws", async () => {
    const calls: string[] = [];
    const sandbox = await withHooks(fakeSandbox(calls), {
      beforeStop: async () => {
        throw new Error("cleanup failed");
      },
    });
    await sandbox.stop();
    expect(calls).toEqual(["stop"]);
  });

  it("runs onTimeout once for each command that timed out, and not for other failures", async () => {
    const hasTimedOut: string[] = [];
    const onTimeout = async (command: string) => void hasTimedOut.push(command);
    const slow = await withHooks(fakeSandbox([], { stdout: "", stderr: "", exitCode: 1, hasTimedOut: true }), { onTimeout });
    const failing = await withHooks(fakeSandbox([], { stdout: "", stderr: "boom", exitCode: 2 }), { onTimeout });
    await slow.exec("sleep 99");
    await failing.exec("false");
    expect(hasTimedOut).toEqual(["sleep 99"]);
  });

  it("the local sandbox reports a command that outran its timeout", async () => {
    const sandbox = await createLocalSandbox(join(mkdtempSync(join(tmpdir(), "hooks-")), "ws"), { execTimeoutMs: 200 });
    const slow = await sandbox.exec("sleep 5");
    const quick = await sandbox.exec("echo hi");
    expect(slow.hasTimedOut).toBe(true);
    expect(quick).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });
  });
});

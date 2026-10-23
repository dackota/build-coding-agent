import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { begin, next } from "../src/loop.ts";
import { type AtomicIo, loadSession, saveSession, type SessionState } from "../src/session-state.ts";

const pause = (n: number): NonNullable<SessionState["pending"]> => ({
  requestId: `req-${n}`,
  taskId: "task-1",
  toolCallId: "call-1",
  questions: [{ question: "q?", choices: [], multiple: false }],
  messages: [{ role: "user", content: "x".repeat(n) }],
});

const state = (n: number, withPause = false): SessionState => ({
  messages: [
    { role: "user", content: `remember ${"y".repeat(n)}` },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ],
  todos: [{ content: `todo ${n}`, status: "pending" }],
  ...(withPause ? { pending: pause(n) } : {}),
});

const sessionFiles = (dir: string, contextId = "ctx-1") => readdirSync(join(dir, "sessions", contextId)).sort();

it("loads an empty session when nothing was saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  expect(loadSession(dir, "ctx-1")).toEqual({ messages: [], todos: [] });
});

it("round-trips a session state with messages, a pending pause, and todos", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  saveSession(dir, "ctx-1", state(5, true));
  expect(loadSession(dir, "ctx-1")).toEqual(state(5, true));
  saveSession(dir, "ctx-1", state(6));
  expect(loadSession(dir, "ctx-1")).toEqual(state(6));
  expect(sessionFiles(dir)).toEqual(["state.json"]);
});

/** Real fs calls until operation number `crashAt`, which dies part-way (a write lands only `cut` bytes); after that every call fails. */
function crashingIo(crashAt: number, cut: number): AtomicIo {
  let op = 0;
  let crashed = false;
  const step = <T>(real: () => T, partial?: () => void): T => {
    op += 1;
    if (crashed || op === crashAt) {
      crashed = true;
      partial?.();
      throw new Error("crash");
    }
    return real();
  };
  return {
    openSync: (path, flags) => step(() => fs.openSync(path, flags)),
    writeSync: (fd: number, data: Buffer) =>
      step(
        () => fs.writeSync(fd, data),
        () => {
          if (!crashed || op !== crashAt) return;
          fs.writeSync(fd, data.subarray(0, Math.min(cut, data.length)));
        },
      ),
    fsyncSync: (fd) => step(() => fs.fsyncSync(fd)),
    // A dying process still has its descriptors closed by the kernel.
    closeSync: (fd) => step(() => fs.closeSync(fd), () => fs.closeSync(fd)),
    renameSync: (from, to) => step(() => fs.renameSync(from, to)),
  } as AtomicIo;
}

it("a crash at any point of a save leaves the old or the new state, never a partial file", () => {
  fc.assert(
    fc.property(fc.nat(2000), fc.nat(2000), fc.boolean(), fc.integer({ min: 1, max: 6 }), fc.nat(5000), (oldN, newN, withPause, crashAt, cut) => {
      const dir = mkdtempSync(join(tmpdir(), "state-"));
      const before = state(oldN);
      const after = state(newN, withPause);
      saveSession(dir, "ctx-1", before);

      try {
        saveSession(dir, "ctx-1", after, crashingIo(crashAt, cut));
      } catch {
        // the crash
      }

      const text = readFileSync(join(dir, "sessions", "ctx-1", "state.json"), "utf8");
      const parsed = JSON.parse(text) as unknown;
      expect([before, after]).toContainEqual(parsed);
      expect([before, after]).toContainEqual(loadSession(dir, "ctx-1"));
      fs.rmSync(dir, { recursive: true, force: true });
    }),
    { numRuns: 200 },
  );
});

it("a later save removes the temp file a crash left", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  saveSession(dir, "ctx-1", state(1));
  writeFileSync(join(dir, "sessions", "ctx-1", "state.json.tmp-999"), '{"messages": [half');
  expect(loadSession(dir, "ctx-1")).toEqual(state(1));

  saveSession(dir, "ctx-1", state(2));

  expect(sessionFiles(dir)).toEqual(["state.json"]);
  expect(loadSession(dir, "ctx-1")).toEqual(state(2));
});

it("refuses a state file that is not a session state", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  mkdirSync(join(dir, "sessions", "ctx-1"), { recursive: true });
  writeFileSync(join(dir, "sessions", "ctx-1", "state.json"), '{"messages": "not a list"}');
  expect(() => loadSession(dir, "ctx-1")).toThrow(/session state/i);
});

it("rejects a context id that could leave the sessions directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  mkdirSync(join(dir, "sessions"));
  for (const bad of ["", "..", "../x", "a/b", "a\\b", "x".repeat(300), "a\0b"]) {
    expect(() => saveSession(dir, bad, state(1))).toThrow(/context id/i);
    expect(() => loadSession(dir, bad)).toThrow(/context id/i);
  }
});

it("saves and loads the loop state", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  const loop = begin({ owner: "acme", repo: "widgets", number: 12 }).state;
  const withIssue = next(loop, { type: "read", issue: { title: "T", body: "B", comments: ["c"] }, baseBranch: "main" }).state;

  saveSession(dir, "ctx-1", { ...state(1), loop: withIssue });

  expect(loadSession(dir, "ctx-1").loop).toEqual(withIssue);
  expect(loadSession(dir, "ctx-1").loop?.step).toBe("ready-check");
});

it("refuses a loop state with an unknown step", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  mkdirSync(join(dir, "sessions", "ctx-1"), { recursive: true });
  writeFileSync(join(dir, "sessions", "ctx-1", "state.json"), JSON.stringify({ messages: [], todos: [], loop: { step: "dance" } }));
  expect(() => loadSession(dir, "ctx-1")).toThrow(/session state/i);
});

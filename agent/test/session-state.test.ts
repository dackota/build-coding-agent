import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { clearPending, loadPending, savePending, type PendingPause } from "../src/session-state.ts";

const pause = (n: number): PendingPause => ({
  requestId: `req-${n}`,
  taskId: "task-1",
  toolCallId: "call-1",
  questions: [{ question: "q?", choices: [], multiple: false }],
  messages: [{ role: "user", content: "x".repeat(n) }],
});

it("round-trips a pending pause and clears it", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  savePending(dir, "ctx-1", pause(5));
  expect(loadPending(dir, "ctx-1")).toEqual(pause(5));
  clearPending(dir, "ctx-1");
  expect(loadPending(dir, "ctx-1")).toBeUndefined();
});

it("never leaves a partial file: after any number of overwrites the only file is a complete JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  for (const n of [0, 1, 10_000, 3, 200_000, 2]) {
    savePending(dir, "ctx-1", pause(n));
    expect(readdirSync(join(dir, "sessions", "ctx-1"))).toEqual(["pending.json"]);
    expect(() => JSON.parse(readFileSync(join(dir, "sessions", "ctx-1", "pending.json"), "utf8"))).not.toThrow();
    expect(loadPending(dir, "ctx-1")).toEqual(pause(n));
  }
});

it("ignores a stray temp file left by a crash before the rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  savePending(dir, "ctx-1", pause(1));
  writeFileSync(join(dir, "sessions", "ctx-1", "pending.json.tmp-999"), '{"requestId": "half');
  expect(loadPending(dir, "ctx-1")).toEqual(pause(1));
});

it("rejects a context id that could leave the sessions directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  mkdirSync(join(dir, "sessions"));
  for (const bad of ["", "..", "../x", "a/b", "a\\b", "x".repeat(300), "a\0b"]) {
    expect(() => savePending(dir, bad, pause(1))).toThrow(/context id/i);
    expect(() => loadPending(dir, bad)).toThrow(/context id/i);
  }
});

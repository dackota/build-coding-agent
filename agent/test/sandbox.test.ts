import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLocalSandbox } from "../src/local-sandbox.ts";
import { createMemorySandbox } from "../src/memory-sandbox.ts";
import type { Sandbox } from "../src/sandbox.ts";

const SECRET = "TOP-SECRET-OUTSIDE";

type Layout = { base: string; workspace: string; outside: string };

/** base/{workspace,outside}: the workspace holds symlinks that point out, to a dir and to a file. */
function layout(): Layout {
  const base = mkdtempSync(join(tmpdir(), "sandbox-prop-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(join(workspace, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), SECRET);
  writeFileSync(join(workspace, "inside.txt"), "inside\n");
  symlinkSync(outside, join(workspace, "link-out"));
  symlinkSync(join(outside, "secret.txt"), join(workspace, "file-link"));
  symlinkSync("../../outside", join(workspace, "sub", "rel-link"));
  return { base, workspace, outside };
}

function snapshot(l: Layout): string {
  const entries = readdirSync(l.outside).sort().map((n) => `${n}=${readFileSync(join(l.outside, n), "utf8")}`);
  return JSON.stringify({ base: readdirSync(l.base).sort(), outside: entries });
}

const SEGMENTS = ["..", ".", "", "outside", "secret.txt", "link-out", "file-link", "sub", "rel-link", "inside.txt", "new.txt", "%2e%2e", "..\\..", "~", "workspace", "\u0000"];

/** Paths a model might send: built from risky segments, rooted or not, plus arbitrary strings. */
function pathArb(l: Layout): fc.Arbitrary<string> {
  const segmented = fc
    .tuple(fc.constantFrom("", "/", "./", `${l.outside}/`, `${l.workspace}/`, `${l.base}/`), fc.array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 6 }))
    .map(([prefix, segs]) => prefix + segs.join("/"));
  return fc.oneof(segmented, fc.string({ maxLength: 40 }));
}

async function neverEscapes(make: (root: string) => Promise<Sandbox>): Promise<void> {
  const l = layout();
  const before = snapshot(l);
  const sandbox = await make(l.workspace);
  try {
    await fc.assert(
      fc.asyncProperty(pathArb(l), fc.boolean(), async (path, isWrite) => {
        if (isWrite) {
          let wrote = false;
          try {
            await sandbox.writeFile(path, "PWNED");
            wrote = true;
          } catch {
            // A refused path is fine; escaping is not.
          }
          if (wrote) expect(await sandbox.readFile(path)).toBe("PWNED");
        } else {
          const got = await sandbox.readFile(path).catch(() => "");
          expect(got).not.toContain(SECRET);
        }
        expect(snapshot(l)).toBe(before);
      }),
      { numRuns: 400 },
    );
  } finally {
    await sandbox.stop();
  }
}

for (const [name, make] of [
  ["local", createLocalSandbox],
  ["in-memory", createMemorySandbox],
] as const) {
  describe(`${name} sandbox`, () => {
    it(`${name} sandbox never reads or writes outside the workspace, for any path`, async () => {
      await neverEscapes(make);
    });

    it("reads and writes paths inside the workspace, and refuses the named escapes with an error", async () => {
      const l = layout();
      const sandbox = await make(l.workspace);
      expect(await sandbox.readFile("inside.txt")).toBe("inside\n");
      await sandbox.writeFile("deep/new/file.txt", "x");
      expect(await sandbox.readFile("deep/new/file.txt")).toBe("x");
      for (const bad of ["../outside/secret.txt", join(l.outside, "secret.txt"), "link-out/secret.txt", "file-link", "sub/rel-link/secret.txt"]) {
        await expect(sandbox.readFile(bad)).rejects.toThrow(/outside the workspace/i);
        await expect(sandbox.writeFile(bad, "PWNED")).rejects.toThrow(/outside the workspace/i);
      }
      expect(readFileSync(join(l.outside, "secret.txt"), "utf8")).toBe(SECRET);
      await sandbox.stop();
    });

    it("runs a command in the workspace", async () => {
      const l = layout();
      const sandbox = await make(l.workspace);
      const got = await sandbox.exec("cat inside.txt");
      expect(got).toEqual({ stdout: "inside\n", stderr: "", exitCode: 0 });
      await sandbox.stop();
    });
  });
}

it("a per-call timeout replaces the sandbox default for that call only", async () => {
  const l = layout();
  const sandbox = await createLocalSandbox(l.workspace, { execTimeoutMs: 300 });

  const stoppedAtDefault = await sandbox.exec("sleep 5");
  const finishedWithLongerLimit = await sandbox.exec("sleep 1; echo done", { timeoutMs: 5000 });
  const stoppedAtOwnLimit = await sandbox.exec("sleep 5", { timeoutMs: 200 });
  const stillDefaultAfter = await sandbox.exec("sleep 5");

  expect(stoppedAtDefault.hasTimedOut).toBe(true);
  expect(finishedWithLongerLimit).toMatchObject({ stdout: "done\n", exitCode: 0 });
  expect(finishedWithLongerLimit.hasTimedOut).toBeUndefined();
  expect(stoppedAtOwnLimit.hasTimedOut).toBe(true);
  expect(stillDefaultAfter.hasTimedOut).toBe(true);
  await sandbox.stop();
});

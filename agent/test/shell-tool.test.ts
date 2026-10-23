import fc from "fast-check";
import { expect, it } from "vitest";
import type { Sandbox } from "../src/sandbox.ts";
import { createShellTool, SAFE_PROGRAMS } from "../src/shell-tool.ts";

function recordingSandbox(): Sandbox & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    readFile: async () => "",
    writeFile: async () => {},
    exec: async (command) => {
      commands.push(command);
      return { stdout: "ran", stderr: "", exitCode: 0 };
    },
    stop: async () => {},
  };
}

const neverApproved = { allows: () => false };
const options = (toolCallId: string) => ({ toolCallId, messages: [] });

it("execute refuses a risky command that was not approved, and never reaches the sandbox", async () => {
  const sandbox = recordingSandbox();
  const shell = createShellTool(sandbox, neverApproved);

  await expect(shell.execute!({ command: "rm -rf build" }, options("call-1"))).rejects.toThrow(/approval/i);

  expect(sandbox.commands).toEqual([]);
});

it("execute runs a safe command with no approval, and returns its output and exit code", async () => {
  const sandbox = recordingSandbox();
  const shell = createShellTool(sandbox, neverApproved);

  const got = await shell.execute!({ command: "ls -la" }, options("call-1"));

  expect(sandbox.commands).toEqual(["ls -la"]);
  expect(String(got)).toContain("ran");
  expect(String(got)).toContain("exit code: 0");
});

it("execute runs a risky command once the gate allows that call", async () => {
  const sandbox = recordingSandbox();
  const shell = createShellTool(sandbox, { allows: (id: string, kinds: string[]) => id === "call-7" && kinds.includes("rm") });

  await shell.execute!({ command: "rm -rf build" }, options("call-7"));

  expect(sandbox.commands).toEqual(["rm -rf build"]);
});

it("every command with a risky program in any segment needs approval", async () => {
  const safe = fc.constantFrom(...SAFE_PROGRAMS.filter((p) => !p.includes(" ")));
  const word = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/);
  const risky = fc.oneof(
    fc.constantFrom("rm", "mv", "chmod", "curl", "sh", "bash", "node", "python3", "dd", "git push", "find"),
    word.filter((w) => !SAFE_PROGRAMS.includes(w) && w !== "git"),
  );
  const segment = fc.tuple(safe, fc.array(word, { maxLength: 3 })).map(([p, args]) => [p, ...args].join(" "));
  const separator = fc.constantFrom("; ", " && ", " | ", " || ", "\n", " & ");
  const shell = createShellTool(recordingSandbox(), neverApproved);

  await fc.assert(
    fc.asyncProperty(fc.array(segment, { maxLength: 3 }), risky, fc.array(word, { maxLength: 2 }), fc.nat(3), separator, async (segments, program, args, at, sep) => {
      const parts = [...segments];
      parts.splice(Math.min(at, parts.length), 0, [program, ...args].join(" "));
      const command = parts.join(sep);
      const needs = typeof shell.needsApproval === "function" ? await shell.needsApproval({ command }, options("c")) : shell.needsApproval;
      expect(needs, command).toBe(true);
    }),
  );
});

it("a command that writes a file through a flag or operand never runs without approval", async () => {
  const word = fc.stringMatching(/^[a-z][a-z0-9_.]{0,8}$/);
  const flags = fc.array(fc.constantFrom("-r", "-n", "-u", "-c", "--stat", "-p", "-a"), { maxLength: 2 });
  const writer = fc.oneof(
    fc.tuple(flags, word, word).map(([f, out, input]) => ["sort", ...f, "-o", out, input].join(" ")),
    fc.tuple(flags, word, word).map(([f, out, input]) => ["sort", ...f, `--output=${out}`, input].join(" ")),
    fc.tuple(flags, word, word).map(([f, input, out]) => ["uniq", ...f, input, out].join(" ")),
    fc.tuple(flags, word).map(([f, out]) => ["tree", ...f, "-o", out].join(" ")),
    fc.tuple(fc.constantFrom("git diff", "git log", "git show"), flags, word).map(([git, f, out]) => [git, ...f, `--output=${out}`].join(" ")),
    fc.tuple(fc.constantFrom("git diff", "git log", "git show"), flags, word).map(([git, f, out]) => [git, ...f, "--output", out].join(" ")),
    fc.tuple(flags, word).map(([f, magic]) => ["file", ...f, "-C", "-m", magic].join(" ")),
  );
  const safe = fc.tuple(fc.constantFrom("ls", "cat", "grep", "pwd", "git status"), fc.array(word, { maxLength: 2 })).map(([p, args]) => [p, ...args].join(" "));
  const separator = fc.constantFrom("; ", " && ", " | ", "\n");
  const sandbox = recordingSandbox();
  const shell = createShellTool(sandbox, neverApproved);

  await fc.assert(
    fc.asyncProperty(fc.array(safe, { maxLength: 2 }), writer, fc.nat(2), separator, async (segments, write, at, sep) => {
      const parts = [...segments];
      parts.splice(Math.min(at, parts.length), 0, write);
      const command = parts.join(sep);
      const needs = typeof shell.needsApproval === "function" ? await shell.needsApproval({ command }, options("c")) : shell.needsApproval;
      expect(needs, command).toBe(true);
      await expect(shell.execute!({ command }, options("c")), command).rejects.toThrow(/approval/i);
      expect(sandbox.commands, command).toEqual([]);
    }),
  );
});

it("redirects and command substitution need approval even after a safe program", async () => {
  const shell = createShellTool(recordingSandbox(), neverApproved);
  const needs = async (command: string) => (typeof shell.needsApproval === "function" ? shell.needsApproval({ command }, options("c")) : shell.needsApproval);

  for (const command of ["echo hi > a.txt", "cat a >> b", "echo $(rm -rf build)", "echo `rm x`", "ls\nrm -rf build", "sort -o x f", "uniq a b", "git diff --output=x", "tree -o x"]) {
    expect(await needs(command), command).toBe(true);
  }
  for (const command of ["ls", "ls -la src", "cat a.txt", "grep -rn foo .", "git status", "git diff HEAD", "pwd"]) {
    expect(await needs(command), command).toBe(false);
  }
});

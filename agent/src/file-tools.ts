// The model's file tools: read, write, edit, and search, all through a Sandbox. A tool that
// fails throws; the AI SDK hands the message back to the model as the tool's error.
import { tool } from "ai";
import { z } from "zod";
import { relativeInWorkspace, type Sandbox, shellQuote } from "./sandbox.ts";
import type { ChangeTracker } from "./workspace-diff.ts";

const MAX_SEARCH_LINES = 200;

const PATH = z.string().describe("A path relative to the workspace root, such as src/index.ts. Absolute paths and '..' are refused.");

function countOf(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

export function createFileTools(sandbox: Sandbox, changes: ChangeTracker) {
  return {
    read_file: tool({
      description: `Read one file in the workspace. Returns its full text.

WHEN TO USE: before editing a file, to see its exact current text; reading a file the user names or attached.

WHEN NOT TO USE: finding which file holds some text (use search); listing a directory (use bash with ls).

DO NOT USE FOR: paths outside the workspace: absolute paths and '..' are refused.

USAGE: path is relative to the workspace root. A very large file is cut, with a note that it was truncated.

EXAMPLES:
  - Read the entry point: path "src/index.ts"
  - Read the manifest: path "package.json"`,
      inputSchema: z.object({ path: PATH }),
      execute: async ({ path }) => {
        // The executor caps every tool's output (context.ts), so a large file is cut there.
        return sandbox.readFile(path);
      },
    }),

    write_file: tool({
      description: `Create a file, or replace a whole file, in the workspace. Returns how many characters were written.

WHEN TO USE: creating a new file; rewriting a small file from scratch.

WHEN NOT TO USE: changing part of an existing file (use edit_file: it keeps the rest exactly).

DO NOT USE FOR: paths outside the workspace, or deleting files.

USAGE: path is relative to the workspace root; parent directories are created. content is the whole new file.

EXAMPLES:
  - New script: path "src/hello.js", content "console.log('hi');\\n"
  - New config: path ".prettierrc", content "{}\\n"`,
      inputSchema: z.object({ path: PATH, content: z.string().describe("The full new content of the file") }),
      execute: async ({ path, content }) => {
        await changes.recordBefore(sandbox, path);
        await sandbox.writeFile(path, content);
        return `wrote ${content.length} characters to ${relativeInWorkspace(path)}`;
      },
    }),

    edit_file: tool({
      description: `Replace exact text in a workspace file. Returns how many occurrences were replaced.

WHEN TO USE: renaming, fixing, or adding a few lines in an existing file.

WHEN NOT TO USE: creating a file or rewriting all of it (use write_file); finding the text first (use read_file or search).

DO NOT USE FOR: paths outside the workspace; text you have not read: copy old_string from read_file output.

USAGE: old_string must match the file exactly (whitespace included) and, unless replace_all is true, appear exactly once: include enough surrounding text to make it unique.

EXAMPLES:
  - Rename a function: old_string "function foo()", new_string "function bar()"
  - Rename every call: old_string "foo(", new_string "bar(", replace_all true`,
      inputSchema: z.object({
        path: PATH,
        old_string: z.string().min(1).describe("The exact text to replace"),
        new_string: z.string().describe("The text to put in its place"),
        replace_all: z.boolean().default(false).describe("Replace every occurrence instead of exactly one"),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        const text = await sandbox.readFile(path);
        const count = countOf(text, old_string);
        if (count === 0) throw new Error(`old_string was not found in ${path}; read the file and copy the text exactly`);
        if (count > 1 && !replace_all) throw new Error(`old_string is not unique: it appears ${count} times in ${path}; add surrounding text, or set replace_all`);
        await changes.recordBefore(sandbox, path);
        await sandbox.writeFile(path, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string));
        return `replaced ${replace_all ? count : 1} occurrence(s) in ${relativeInWorkspace(path)}`;
      },
    }),

    search: tool({
      description: `Search the workspace files for a literal string. Returns path:line:text for each match.

WHEN TO USE: finding where something is defined or used; finding which file to read or edit.

WHEN NOT TO USE: reading a file you already know (use read_file); listing files (use bash with ls).

DO NOT USE FOR: regular expressions: the pattern is matched as plain text.

USAGE: path narrows the search to a file or directory; left out, the whole workspace. At most ${MAX_SEARCH_LINES} matches are shown.

EXAMPLES:
  - Find a function: pattern "function foo("
  - Find uses in one folder: pattern "foo(", path "src"`,
      inputSchema: z.object({
        pattern: z.string().min(1).describe("The literal text to find (not a regular expression)"),
        path: PATH.optional().describe("A directory or file to search in; the whole workspace when left out"),
      }),
      execute: async ({ pattern, path }) => {
        // Always grep the whole tree and filter by path: a recursive grep does not follow the
        // symlinks it meets inside the tree, but it would follow one named as its operand.
        const within = path === undefined ? undefined : relativeInWorkspace(path);
        const got = await sandbox.exec(`grep -rnF -e ${shellQuote(pattern)} -- .`);
        if (got.exitCode > 1) throw new Error(`search failed: ${got.stderr.trim() || `exit ${got.exitCode}`}`);
        const lines = got.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => l.replace(/^\.\//, ""))
          .filter((l) => within === undefined || l.startsWith(`${within}:`) || l.startsWith(`${within}/`));
        if (lines.length === 0) return "no matches";
        const shown = lines.slice(0, MAX_SEARCH_LINES).join("\n");
        return lines.length > MAX_SEARCH_LINES ? `${shown}\n[${lines.length - MAX_SEARCH_LINES} more matches not shown]` : shown;
      },
    }),
  };
}

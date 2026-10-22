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
      description: "Read a file in the workspace. Use it before editing a file, to see its exact current text.",
      inputSchema: z.object({ path: PATH }),
      execute: async ({ path }) => {
        // The executor caps every tool's output (context.ts), so a large file is cut there.
        return sandbox.readFile(path);
      },
    }),

    write_file: tool({
      description: "Create a file, or replace a whole file, in the workspace. To change part of an existing file, use edit_file instead.",
      inputSchema: z.object({ path: PATH, content: z.string().describe("The full new content of the file") }),
      execute: async ({ path, content }) => {
        await changes.recordBefore(sandbox, path);
        await sandbox.writeFile(path, content);
        return `wrote ${content.length} characters to ${relativeInWorkspace(path)}`;
      },
    }),

    edit_file: tool({
      description:
        "Replace exact text in a workspace file. old_string must match the file exactly (whitespace included) and, unless replace_all is true, appear exactly once: include enough surrounding text to make it unique.",
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
      description: "Search the workspace files for a literal string. Returns path:line:text for each match. Use it to find where something is defined or used.",
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

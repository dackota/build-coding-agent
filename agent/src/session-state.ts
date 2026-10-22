// Session state on disk: one JSON file, <data dir>/sessions/<contextId>/state.json, holding the
// conversation, the pending pause, and the todos. A wake is a cold start, so every turn loads
// it and every step saves it. Each save goes to a temp file, is fsynced, then renamed over
// the old file, so a crash or a snapshot never captures half a file.
import * as fs from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "./log.ts";

export type PendingPause = {
  requestId: string;
  taskId: string;
  toolCallId: string;
  questions: { question: string; choices: string[]; multiple: boolean }[];
  /** The model conversation up to and including the ask_user call. */
  messages: unknown[];
  /** Each file's content before the turn's first write, so the diff after the answer covers the whole turn. */
  baseline?: Record<string, string | null>;
};

export type Todo = { content: string; status: "pending" | "in_progress" | "completed" };

export type SessionState = {
  /** The model conversation of every finished step, in order. */
  messages: unknown[];
  /** The ask_user question the session is paused on, if any. */
  pending?: PendingPause;
  todos: Todo[];
};

/** The fs calls an atomic write makes; a test swaps them to crash part-way. */
export type AtomicIo = Pick<typeof fs, "openSync" | "writeSync" | "fsyncSync" | "closeSync" | "renameSync">;

const STATE_FILE = "state.json";
const TEMP_PREFIX = `${STATE_FILE}.tmp-`;
const CONTEXT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const pendingSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  toolCallId: z.string(),
  questions: z.array(z.object({ question: z.string(), choices: z.array(z.string()), multiple: z.boolean() })),
  messages: z.array(z.unknown()),
  baseline: z.record(z.string(), z.string().nullable()).optional(),
});

const stateSchema = z.object({
  messages: z.array(z.unknown()),
  pending: pendingSchema.optional(),
  todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
});

/** <data dir>/<kind>/<contextId>, after checking the context id cannot climb out. */
function contextDir(dataDir: string, kind: "sessions" | "workspaces", contextId: string): string {
  if (!CONTEXT_ID.test(contextId)) throw new Error("invalid context id: it must be 1-128 letters, digits, '-' or '_'");
  return join(dataDir, kind, contextId);
}

const sessionDir = (dataDir: string, contextId: string) => contextDir(dataDir, "sessions", contextId);

/** The workspace for a context: <data dir>/workspaces/<contextId>/. */
export const workspaceDir = (dataDir: string, contextId: string): string => contextDir(dataDir, "workspaces", contextId);

export const emptySession = (): SessionState => ({ messages: [], todos: [] });

/** Write `data` to <dir>/state.json atomically: temp file, fsync, rename. */
function writeAtomic(dir: string, data: Buffer, io: AtomicIo): void {
  const tmp = join(dir, `${TEMP_PREFIX}${process.pid}`);
  const fd = io.openSync(tmp, "w");
  try {
    io.writeSync(fd, data);
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
  io.renameSync(tmp, join(dir, STATE_FILE));
}

/** Temp files a crash left before its rename; never read, removed after the next good save. */
function removeStaleTemps(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(TEMP_PREFIX)) fs.rmSync(join(dir, name), { force: true });
  }
}

export function saveSession(dataDir: string, contextId: string, state: SessionState, io: AtomicIo = fs): void {
  const dir = sessionDir(dataDir, contextId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(dir, Buffer.from(JSON.stringify(state), "utf8"), io);
  removeStaleTemps(dir);
  // Counts and file names only: what a live check can see of /data without a shell in the actor.
  log("session-saved", {
    contextId,
    messages: state.messages.length,
    todos: state.todos.length,
    pending: state.pending?.requestId ?? "",
    files: fs.readdirSync(dir).sort().join(","),
  });
}

/** The saved session, or an empty one when the context has none yet. Throws on a file that is not a session state. */
export function loadSession(dataDir: string, contextId: string): SessionState {
  const file = join(sessionDir(dataDir, contextId), STATE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptySession();
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`invalid session state in ${file}: not JSON`);
  }
  const parsed = stateSchema.safeParse(json);
  if (!parsed.success) throw new Error(`invalid session state in ${file}: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  return parsed.data as SessionState;
}

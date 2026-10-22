// Session state on disk: JSON under <data dir>/sessions/<contextId>/, written temp-then-rename
// so a crash or a snapshot never captures half a file.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export type PendingPause = {
  requestId: string;
  taskId: string;
  toolCallId: string;
  questions: { question: string; choices: string[]; multiple: boolean }[];
  /** The model conversation up to and including the ask_user call. */
  messages: unknown[];
};

const PENDING_FILE = "pending.json";
const CONTEXT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function sessionDir(dataDir: string, contextId: string): string {
  if (!CONTEXT_ID.test(contextId)) throw new Error("invalid context id: it must be 1-128 letters, digits, '-' or '_'");
  return join(dataDir, "sessions", contextId);
}

export function savePending(dataDir: string, contextId: string, pause: PendingPause): void {
  const dir = sessionDir(dataDir, contextId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${PENDING_FILE}.tmp-${process.pid}`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(pause));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, PENDING_FILE));
}

export function loadPending(dataDir: string, contextId: string): PendingPause | undefined {
  const file = join(sessionDir(dataDir, contextId), PENDING_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as PendingPause;
}

export function clearPending(dataDir: string, contextId: string): void {
  rmSync(join(sessionDir(dataDir, contextId), PENDING_FILE), { force: true });
}

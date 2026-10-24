import { readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import { TaskState } from "@a2a-js/sdk";
import type { ListTasksRequest, ListTasksResponse } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { log } from "./log.ts";
import { taskStoreMethods, type Task } from "./wire.ts";

export const DEFAULT_IDENTITY_PATH = "/run/kagent/identity/name";
const DISPATCH_HEADER = "x-kagent-dispatch-id";
const SESSION_PREFIX = "session-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Substrate replaces this placeholder with the calling Actor's JWT where the call leaves
// for the controller's runtime origin (kagent's own ADK does the same).
const AUTHORIZATION = "Bearer placeholder";
const ATTEMPTS = 4;
const CALL_TIMEOUT_MS = 30_000;
const BOUNDARY_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

export type ControllerTaskStoreOptions = {
  /** runtime.control_plane_url from the kagent config: scheme and authority only. */
  controlPlaneUrl: string;
  /** Where Substrate projects the actor's name, `session-<uuid>`. */
  identityPath: string;
};

/**
 * Keeps A2A tasks in kagent's controller (kagent.runtime.v1.TaskStoreService), the way the
 * Go ADK does: creates carry no version, updates carry the version the controller last
 * returned, and a save that ends in a boundary state (terminal or input-required) is
 * settled so the controller can publish it and let the actor suspend.
 */
export class ControllerTaskStore implements TaskStore {
  private readonly opts: ControllerTaskStoreOptions;
  private readonly client: grpc.Client;
  private readonly versions = new Map<string, number>();
  private readonly states = new Map<string, TaskState>();

  constructor(opts: ControllerTaskStoreOptions) {
    this.opts = opts;
    const url = new URL(opts.controlPlaneUrl);
    const secure = url.protocol === "https:";
    const target = `${url.hostname}:${url.port || (secure ? 443 : 80)}`;
    this.client = new grpc.Client(target, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const sessionId = this.sessionId();
    const dispatchId = dispatchIdOf(context);
    const known = this.versions.get(task.id);
    let version: number;
    if (known === undefined) {
      ({ version } = await this.call("createTask", { sessionId, task, dispatchId }));
    } else {
      ({ version } = await this.call("updateTask", { sessionId, task, expectedVersion: known, dispatchId }));
    }
    this.versions.set(task.id, version);
    const previousState = this.states.get(task.id);
    const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
    this.states.set(task.id, state);
    log("task-saved", { taskId: task.id, state: task.status?.state ?? 0, previousVersion: known ?? 0, version });
    if (isBoundary(previousState, state)) {
      await this.call("settleTask", { sessionId, taskId: task.id, version });
      log("task-settled", { taskId: task.id, version });
    }
  }

  async load(taskId: string, _context: ServerCallContext): Promise<Task | undefined> {
    try {
      const stored = await this.call("getTask", { sessionId: this.sessionId(), taskId });
      this.versions.set(taskId, stored.version);
      this.states.set(taskId, stored.task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
      return stored.task;
    } catch (err) {
      if ((err as grpc.ServiceError).code === grpc.status.NOT_FOUND) return undefined;
      throw err;
    }
  }

  async list(params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    const { result } = await this.call("listTasks", { sessionId: this.sessionId(), request: params });
    return result;
  }

  close(): void {
    this.client.close();
  }

  /** Read on every call: Substrate rebinds the identity when an actor is restored or forked. */
  private sessionId(): string {
    let name: string;
    try {
      name = readFileSync(this.opts.identityPath, "utf8").trim();
    } catch (err) {
      throw new Error(`cannot read the runtime identity at ${this.opts.identityPath}: ${(err as Error).message}`);
    }
    const id = name.startsWith(SESSION_PREFIX) ? name.slice(SESSION_PREFIX.length) : "";
    if (!UUID.test(id)) throw new Error(`runtime identity at ${this.opts.identityPath} is not a session actor name`);
    return id;
  }

  private async call<K extends keyof typeof taskStoreMethods>(
    method: K,
    request: Parameters<(typeof taskStoreMethods)[K]["request"]["encode"]>[0],
  ): Promise<ReturnType<(typeof taskStoreMethods)[K]["response"]["decode"]>> {
    const m = taskStoreMethods[method];
    for (let attempt = 1; ; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          const metadata = new grpc.Metadata();
          metadata.set("authorization", AUTHORIZATION);
          this.client.makeUnaryRequest(
            m.path,
            (v: unknown) => m.request.encode(v as never),
            (b: Buffer) => m.response.decode(b),
            request,
            metadata,
            { deadline: Date.now() + CALL_TIMEOUT_MS },
            (err, res) => (err ? reject(err) : resolve(res as never)),
          );
        });
      } catch (err) {
        const code = (err as grpc.ServiceError).code;
        const retryable = code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED;
        if (!retryable || attempt >= ATTEMPTS) {
          const details = (err as grpc.ServiceError).details ?? (err as Error).message;
          if (code !== grpc.status.NOT_FOUND) log("task-store-failed", { method, code, details });
          throw Object.assign(new Error(`task store ${method}: ${details}`), { code });
        }
        await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
      }
    }
  }
}

/**
 * The controller publishes and settles only real boundaries: a terminal state, or a move
 * into a waiting state. The SDK also saves a waiting task unchanged when the user's reply
 * arrives; settling that save is refused ("task changed"), which would fail the whole turn.
 */
function isBoundary(previous: TaskState | undefined, next: TaskState): boolean {
  if (!BOUNDARY_STATES.has(next)) return false;
  const waiting = next === TaskState.TASK_STATE_INPUT_REQUIRED || next === TaskState.TASK_STATE_AUTH_REQUIRED;
  return !waiting || previous !== next;
}

function dispatchIdOf(context: ServerCallContext): string | undefined {
  const headers = context.state.get("headers") as Record<string, string | string[] | undefined> | undefined;
  const value = headers?.[DISPATCH_HEADER];
  const id = Array.isArray(value) ? value[0] : value;
  return id && UUID.test(id) ? id : undefined;
}

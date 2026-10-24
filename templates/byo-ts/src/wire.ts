// Hand-written protobuf codecs for kagent.runtime.v1.TaskStoreService (kagent 1.0.0-alpha17,
// proto/kagent/runtime/v1/task_store.proto). No generated TypeScript exists for it. The A2A
// messages inside (Task, ListTasksRequest, ListTasksResponse) reuse the codecs of
// @a2a-js/sdk's gRPC service, whose GetTask and ListTasks methods carry exactly those types.
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { A2AService } from "@a2a-js/sdk/server/grpc";

type Rpc<Req, Res> = { path: string; request: Codec<Req>; response: Codec<Res> };
export type Codec<T> = { encode(value: T): Buffer; decode(bytes: Buffer): T };

export type Task = ReturnType<(typeof A2AService)["getTask"]["responseDeserialize"]>;
export type ListTasksRequest = ReturnType<(typeof A2AService)["listTasks"]["requestDeserialize"]>;
export type ListTasksResponse = ReturnType<(typeof A2AService)["listTasks"]["responseDeserialize"]>;

const SERVICE = "/kagent.runtime.v1.TaskStoreService";

const taskCodec = { encode: A2AService.getTask.responseSerialize, decode: A2AService.getTask.responseDeserialize };
const listRequestCodec = { encode: A2AService.listTasks.requestSerialize, decode: A2AService.listTasks.requestDeserialize };
const listResponseCodec = { encode: A2AService.listTasks.responseSerialize, decode: A2AService.listTasks.responseDeserialize };

/** Writes fields in number order and reads them back, skipping any field it does not know. */
function message<T>(write: (w: BinaryWriter, v: T) => void, read: (r: BinaryReader, end: number, out: Record<string, any>) => boolean, init: () => Record<string, any>): Codec<T> {
  return {
    encode: (value) => {
      const w = new BinaryWriter();
      write(w, value);
      return Buffer.from(w.finish());
    },
    decode: (bytes) => {
      const r = new BinaryReader(bytes);
      const out = init();
      while (r.pos < r.len) {
        const [field, wireType] = r.tag();
        if (!read(r, field, out)) r.skip(wireType);
      }
      return out as T;
    },
  };
}

const sub = (w: BinaryWriter, field: number, bytes: Uint8Array) => w.uint32((field << 3) | 2).bytes(bytes);
const str = (w: BinaryWriter, field: number, value: string | undefined) => {
  if (value) w.uint32((field << 3) | 2).string(value);
};
const int = (w: BinaryWriter, field: number, value: number) => {
  if (value) w.uint32(field << 3).int64(value);
};

type CreateReq = { sessionId: string; task: Task; dispatchId?: string };
type UpdateReq = { sessionId: string; task: Task; expectedVersion: number; dispatchId?: string };
type VersionRes = { version: number };
type GetReq = { sessionId: string; taskId: string };
type GetRes = { task: Task; version: number };
type ListReq = { sessionId: string; request: ListTasksRequest };
type ListRes = { result: ListTasksResponse };
type SettleReq = { sessionId: string; taskId: string; version: number };

const versionResponse = message<VersionRes>(
  (w, v) => int(w, 1, v.version),
  (r, f, o) => (f === 1 ? ((o.version = Number(r.int64())), true) : false),
  () => ({ version: 0 }),
);

export const taskStoreMethods = {
  createTask: {
    path: `${SERVICE}/CreateTask`,
    request: message<CreateReq>(
      (w, v) => {
        str(w, 1, v.sessionId);
        sub(w, 2, taskCodec.encode(v.task));
        str(w, 3, v.dispatchId);
      },
      (r, f, o) => (f === 1 ? ((o.sessionId = r.string()), true) : f === 2 ? ((o.task = taskCodec.decode(Buffer.from(r.bytes()))), true) : f === 3 ? ((o.dispatchId = r.string()), true) : false),
      () => ({}),
    ),
    response: versionResponse,
  } satisfies Rpc<CreateReq, VersionRes>,
  updateTask: {
    path: `${SERVICE}/UpdateTask`,
    request: message<UpdateReq>(
      (w, v) => {
        str(w, 1, v.sessionId);
        sub(w, 2, taskCodec.encode(v.task));
        int(w, 3, v.expectedVersion);
        str(w, 5, v.dispatchId);
      },
      (r, f, o) =>
        f === 1 ? ((o.sessionId = r.string()), true)
        : f === 2 ? ((o.task = taskCodec.decode(Buffer.from(r.bytes()))), true)
        : f === 3 ? ((o.expectedVersion = Number(r.int64())), true)
        : f === 5 ? ((o.dispatchId = r.string()), true)
        : false,
      () => ({ expectedVersion: 0 }),
    ),
    response: versionResponse,
  } satisfies Rpc<UpdateReq, VersionRes>,
  getTask: {
    path: `${SERVICE}/GetTask`,
    request: message<GetReq>(
      (w, v) => {
        str(w, 1, v.sessionId);
        str(w, 2, v.taskId);
      },
      (r, f, o) => (f === 1 ? ((o.sessionId = r.string()), true) : f === 2 ? ((o.taskId = r.string()), true) : false),
      () => ({}),
    ),
    // GetTaskResponse { StoredTask stored = 1 }, StoredTask { Task task = 1; int64 version = 2 }
    response: message<GetRes>(
      (w, v) => {
        const inner = new BinaryWriter();
        sub(inner, 1, taskCodec.encode(v.task));
        int(inner, 2, v.version);
        sub(w, 1, inner.finish());
      },
      (r, f, o) => {
        if (f !== 1) return false;
        const inner = new BinaryReader(r.bytes());
        while (inner.pos < inner.len) {
          const [field, wireType] = inner.tag();
          if (field === 1) o.task = taskCodec.decode(Buffer.from(inner.bytes()));
          else if (field === 2) o.version = Number(inner.int64());
          else inner.skip(wireType);
        }
        return true;
      },
      () => ({ version: 0 }),
    ),
  } satisfies Rpc<GetReq, GetRes>,
  listTasks: {
    path: `${SERVICE}/ListTasks`,
    request: message<ListReq>(
      (w, v) => {
        str(w, 1, v.sessionId);
        sub(w, 2, listRequestCodec.encode(v.request));
      },
      (r, f, o) => (f === 1 ? ((o.sessionId = r.string()), true) : f === 2 ? ((o.request = listRequestCodec.decode(Buffer.from(r.bytes()))), true) : false),
      () => ({}),
    ),
    response: message<ListRes>(
      (w, v) => sub(w, 1, listResponseCodec.encode(v.result)),
      (r, f, o) => (f === 1 ? ((o.result = listResponseCodec.decode(Buffer.from(r.bytes()))), true) : false),
      () => ({}),
    ),
  } satisfies Rpc<ListReq, ListRes>,
  settleTask: {
    path: `${SERVICE}/SettleTask`,
    request: message<SettleReq>(
      (w, v) => {
        str(w, 1, v.sessionId);
        str(w, 2, v.taskId);
        int(w, 3, v.version);
      },
      (r, f, o) => (f === 1 ? ((o.sessionId = r.string()), true) : f === 2 ? ((o.taskId = r.string()), true) : f === 3 ? ((o.version = Number(r.int64())), true) : false),
      () => ({ version: 0 }),
    ),
    response: message<Record<string, never>>(() => {}, () => false, () => ({})),
  } satisfies Rpc<SettleReq, Record<string, never>>,
};

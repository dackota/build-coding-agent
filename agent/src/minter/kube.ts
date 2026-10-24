// The few Kubernetes calls the minter makes, and an in-cluster client for them over the API
// server's REST API with the pod's ServiceAccount token. Node built-ins only: the minter runs
// from its source on the plain node image, with no dependencies installed.
import { readFileSync } from "node:fs";
import { request } from "node:https";

export type ObjectMeta = { name: string; labels: Record<string, string>; annotations: Record<string, string> };
export type ConfigMapObject = { name: string; labels: Record<string, string>; data: Record<string, string> };
export type SecretWrite = { name: string; labels: Record<string, string>; annotations: Record<string, string>; stringData: Record<string, string> };

export interface KubeClient {
  listConfigMaps(namespace: string, labelSelector: string): Promise<ConfigMapObject[]>;
  /** Secrets' metadata only: the minter never reads a key back. */
  listSecretMetadata(namespace: string, labelSelector: string): Promise<ObjectMeta[]>;
  getConfigMap(namespace: string, name: string): Promise<ConfigMapObject>;
  /** Create the Secret, or replace it when it exists. */
  putSecret(namespace: string, secret: SecretWrite): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  /** A JSON merge patch of the ConfigMap's data: null removes an entry. */
  patchConfigMapData(namespace: string, name: string, data: Record<string, string | null>): Promise<void>;
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const PARTIAL_METADATA_LIST = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1";
const REQUEST_TIMEOUT_MS = 20_000;

type RawMeta = { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
type Response = { status: number; body: string };

export class KubeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const meta = (m: RawMeta = {}): ObjectMeta => ({ name: m.name ?? "", labels: m.labels ?? {}, annotations: m.annotations ?? {} });
const enc = encodeURIComponent;

/** The API server as the pod sees it: its Service address, the ServiceAccount's token and CA. */
export function inClusterKube(env: NodeJS.ProcessEnv = process.env): KubeClient {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = Number(env.KUBERNETES_SERVICE_PORT ?? 443);
  if (!host) throw new Error("KUBERNETES_SERVICE_HOST is not set: the minter runs only inside the cluster");
  const ca = readFileSync(`${SA_DIR}/ca.crt`);

  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    // Read on every call: the projected token rotates.
    const token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        { host, port, method, path, ca, timeout: REQUEST_TIMEOUT_MS, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`${method} ${path}: no answer in ${REQUEST_TIMEOUT_MS}ms`)));
      req.on("error", reject);
      req.end(payload);
    });
  }

  /** Call and fail on a non-2xx status; the API's own message says which object and why (it never holds a Secret's data). */
  async function ok(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
    const res = await call(method, path, body, headers);
    if (res.status < 200 || res.status > 299) {
      let message = res.body.slice(0, 300);
      try {
        message = (JSON.parse(res.body) as { message?: string }).message ?? message;
      } catch {
        // not JSON: keep the start of the body
      }
      throw new KubeError(res.status, `${method} ${path}: ${res.status} ${message}`);
    }
    return res;
  }

  return {
    async listConfigMaps(namespace, labelSelector) {
      const res = await ok("GET", `/api/v1/namespaces/${enc(namespace)}/configmaps?labelSelector=${enc(labelSelector)}`);
      const items = (JSON.parse(res.body) as { items?: { metadata?: RawMeta; data?: Record<string, string> }[] }).items ?? [];
      return items.map((i) => ({ name: i.metadata?.name ?? "", labels: i.metadata?.labels ?? {}, data: i.data ?? {} }));
    },
    async listSecretMetadata(namespace, labelSelector) {
      const res = await ok("GET", `/api/v1/namespaces/${enc(namespace)}/secrets?labelSelector=${enc(labelSelector)}`, undefined, { accept: PARTIAL_METADATA_LIST });
      const items = (JSON.parse(res.body) as { items?: { metadata?: RawMeta }[] }).items ?? [];
      return items.map((i) => meta(i.metadata));
    },
    async getConfigMap(namespace, name) {
      const res = await ok("GET", `/api/v1/namespaces/${enc(namespace)}/configmaps/${enc(name)}`);
      const cm = JSON.parse(res.body) as { metadata?: RawMeta; data?: Record<string, string> };
      return { name, labels: cm.metadata?.labels ?? {}, data: cm.data ?? {} };
    },
    async putSecret(namespace, secret) {
      const object = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: secret.name, namespace, labels: secret.labels, annotations: secret.annotations },
        type: "Opaque",
        stringData: secret.stringData,
      };
      const created = await call("POST", `/api/v1/namespaces/${enc(namespace)}/secrets`, object, { "content-type": "application/json" });
      if (created.status >= 200 && created.status <= 299) return;
      if (created.status !== STATUS_CONFLICT) throw new KubeError(created.status, `POST secret ${namespace}/${secret.name}: ${created.status}`);
      await ok("PUT", `/api/v1/namespaces/${enc(namespace)}/secrets/${enc(secret.name)}`, object, { "content-type": "application/json" });
    },
    async deleteSecret(namespace, name) {
      const res = await call("DELETE", `/api/v1/namespaces/${enc(namespace)}/secrets/${enc(name)}`);
      if ((res.status < 200 || res.status > 299) && res.status !== STATUS_NOT_FOUND) throw new KubeError(res.status, `DELETE secret ${namespace}/${name}: ${res.status}`);
    },
    async patchConfigMapData(namespace, name, data) {
      await ok("PATCH", `/api/v1/namespaces/${enc(namespace)}/configmaps/${enc(name)}`, { data }, { "content-type": "application/merge-patch+json" });
    },
  };
}

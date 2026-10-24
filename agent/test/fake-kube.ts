// An in-memory Kubernetes for the minter's adapter: ConfigMaps and Secrets by namespace and
// name, label-selector lists, and a log of every write the adapter makes.
import type { ConfigMapObject, KubeClient, ObjectMeta, SecretWrite } from "../src/minter/kube.ts";

type Stored = { labels: Record<string, string>; annotations: Record<string, string>; data: Record<string, string> };
export type Write =
  | { op: "put-secret"; namespace: string; name: string }
  | { op: "delete-secret"; namespace: string; name: string }
  | { op: "patch-configmap"; namespace: string; name: string; data: Record<string, string | null> };

const key = (namespace: string, name: string) => `${namespace}/${name}`;

/** "a=b,c=d" against a label map. */
function matches(selector: string, labels: Record<string, string>): boolean {
  return selector
    .split(",")
    .filter((s) => s !== "")
    .every((pair) => {
      const [k, v] = pair.split("=");
      return labels[k!] === v;
    });
}

export class FakeKube implements KubeClient {
  readonly configMaps = new Map<string, Stored>();
  readonly secrets = new Map<string, Stored>();
  readonly writes: Write[] = [];

  seedConfigMap(namespace: string, name: string, labels: Record<string, string>, data: Record<string, string>): void {
    this.configMaps.set(key(namespace, name), { labels, annotations: {}, data: { ...data } });
  }

  seedSecret(namespace: string, name: string, labels: Record<string, string>, annotations: Record<string, string>, data: Record<string, string>): void {
    this.secrets.set(key(namespace, name), { labels, annotations, data });
  }

  secret(namespace: string, name: string): Stored | undefined {
    return this.secrets.get(key(namespace, name));
  }

  configMap(namespace: string, name: string): Stored | undefined {
    return this.configMaps.get(key(namespace, name));
  }

  async listConfigMaps(namespace: string, labelSelector: string): Promise<ConfigMapObject[]> {
    return [...this.configMaps.entries()]
      .filter(([k, v]) => k.startsWith(`${namespace}/`) && matches(labelSelector, v.labels))
      .map(([k, v]) => ({ name: k.slice(namespace.length + 1), labels: v.labels, data: { ...v.data } }));
  }

  async listSecretMetadata(namespace: string, labelSelector: string): Promise<ObjectMeta[]> {
    return [...this.secrets.entries()]
      .filter(([k, v]) => k.startsWith(`${namespace}/`) && matches(labelSelector, v.labels))
      .map(([k, v]) => ({ name: k.slice(namespace.length + 1), labels: v.labels, annotations: v.annotations }));
  }

  async getConfigMap(namespace: string, name: string): Promise<ConfigMapObject> {
    const cm = this.configMaps.get(key(namespace, name));
    if (!cm) throw new Error(`configmaps "${name}" not found in ${namespace}`);
    return { name, labels: cm.labels, data: { ...cm.data } };
  }

  async putSecret(namespace: string, secret: SecretWrite): Promise<void> {
    this.writes.push({ op: "put-secret", namespace, name: secret.name });
    this.secrets.set(key(namespace, secret.name), { labels: secret.labels, annotations: secret.annotations, data: { ...secret.stringData } });
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.writes.push({ op: "delete-secret", namespace, name });
    this.secrets.delete(key(namespace, name));
  }

  async patchConfigMapData(namespace: string, name: string, data: Record<string, string | null>): Promise<void> {
    this.writes.push({ op: "patch-configmap", namespace, name, data });
    const cm = this.configMaps.get(key(namespace, name));
    if (!cm) throw new Error(`configmaps "${name}" not found in ${namespace}`);
    const next = { ...cm.data };
    for (const [k, v] of Object.entries(data)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    this.configMaps.set(key(namespace, name), { ...cm, data: next });
  }
}

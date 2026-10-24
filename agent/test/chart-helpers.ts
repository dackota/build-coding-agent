// Render the platform's Helm charts with the helm on PATH, as Argo CD's repo server does.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments, stringify } from "yaml";
import { AGENT_DIR } from "./helpers.ts";

export const REPO_ROOT = join(AGENT_DIR, "..");
export const PLATFORM_DIR = join(REPO_ROOT, "platform");
export const AGENT_CHART = join(PLATFORM_DIR, "charts", "agent");
export const TEAMS_CHART = join(PLATFORM_DIR, "charts", "teams");

export type K8sObject = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; [k: string]: any }; [k: string]: any };
export type Render = { ok: boolean; output: string; objects: K8sObject[] };

/** Write values to a temp file, as a values file in the deployments folder would be. */
export function valuesFile(values: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "chart-values-"));
  const file = join(dir, "values.yaml");
  writeFileSync(file, stringify(values));
  return file;
}

/** helm template RELEASE CHART -n NAMESPACE -f FILE...; ok is helm's exit status, output its stderr on failure. */
export function render(chart: string, release: string, namespace: string, files: string[]): Render {
  const args = ["template", release, chart, "--namespace", namespace, ...files.flatMap((f) => ["-f", f])];
  const res = spawnSync("helm", args, { encoding: "utf8" });
  const ok = res.status === 0;
  const objects = ok
    ? parseAllDocuments(res.stdout)
        .map((d) => d.toJS() as K8sObject | null)
        .filter((o): o is K8sObject => o !== null)
    : [];
  return { ok, output: ok ? res.stdout : `${res.stderr}${res.error ?? ""}`, objects };
}

export function find(objects: K8sObject[], kind: string, name: string, namespace?: string): K8sObject | undefined {
  return objects.find((o) => o.kind === kind && o.metadata.name === name && (namespace === undefined || o.metadata.namespace === namespace));
}

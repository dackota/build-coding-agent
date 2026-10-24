// The minter's deployment (teams chart) and the keyed model route (platform/gateway.yaml):
// a CronJob every minute, RBAC only for what it writes, and a model route that wants a key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { find, type K8sObject, PLATFORM_DIR, render, TEAMS_CHART, valuesFile } from "./chart-helpers.ts";

const WORKER = "ghcr.io/kagent-dev/substrate/ateworker-gvisor:v0.6.0-alpha3@sha256:56e6231c3ed48d54afd3068b6313a1545df1277e0ac1faa6090085cc480d573e";
const NODE = "node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const VALUES = {
  teams: ["platform", "payments"],
  workerImage: WORKER,
  gitops: { repoURL: "https://github.com/dackota/build-coding-agent.git", revision: "main" },
  minter: { image: NODE, source: { main: "// main", plan: "// plan" } },
};
const MINTER_NS = "platform-system";

const renderTeams = (values: unknown = VALUES) => render(TEAMS_CHART, "teams", "argocd", [valuesFile(values)]);

function rulesIn(objects: K8sObject[], namespace: string) {
  return objects.filter((o) => o.kind === "Role" && o.metadata.namespace === namespace).flatMap((o) => o.rules as { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] }[]);
}

describe("minter deployment", () => {
  it("grants Secrets only in team namespaces and the API-key ConfigMap by name; no ClusterRole", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    expect(r.objects.filter((o) => o.kind === "ClusterRole" || o.kind === "ClusterRoleBinding")).toEqual([]);

    const roleNamespaces = new Set(r.objects.filter((o) => o.kind === "Role").map((o) => o.metadata.namespace));
    expect([...roleNamespaces].sort()).toEqual(["agentgateway-system", "team-payments", "team-platform"]);

    for (const ns of ["team-platform", "team-payments"]) {
      const rules = rulesIn(r.objects, ns);
      expect(rules, ns).toEqual(
        expect.arrayContaining([
          { apiGroups: [""], resources: ["configmaps"], verbs: ["list"] },
          { apiGroups: [""], resources: ["secrets"], verbs: ["list", "create", "update", "delete"] },
        ]),
      );
      expect(rules, ns).toHaveLength(2);
      const binding = find(r.objects, "RoleBinding", "minter", ns)!;
      expect(binding.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "minter" });
      expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: "minter", namespace: MINTER_NS }]);
    }

    expect(rulesIn(r.objects, "agentgateway-system")).toEqual([{ apiGroups: [""], resources: ["configmaps"], resourceNames: ["agent-api-keys"], verbs: ["get", "patch"] }]);
    for (const rule of r.objects.filter((o) => o.kind === "Role").flatMap((o) => o.rules)) {
      expect(rule.verbs).not.toContain("*");
      expect(rule.resources).not.toContain("*");
    }
  });

  it("runs the minter every minute from its source on the pinned node image", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    expect(find(r.objects, "Namespace", MINTER_NS)).toBeDefined();
    expect(find(r.objects, "ServiceAccount", "minter", MINTER_NS)).toBeDefined();

    const source = find(r.objects, "ConfigMap", "minter-src", MINTER_NS)!;
    expect(source.data).toEqual({ "main.ts": "// main", "plan.ts": "// plan", "package.json": '{"type":"module"}' });

    const job = find(r.objects, "CronJob", "minter", MINTER_NS)!;
    expect(job.spec.schedule).toBe("* * * * *");
    expect(job.spec.concurrencyPolicy).toBe("Forbid");
    const pod = job.spec.jobTemplate.spec.template.spec;
    expect(pod.serviceAccountName).toBe("minter");
    expect(pod.restartPolicy).toBe("Never");
    const [container] = pod.containers;
    expect(container.image).toBe(NODE);
    expect(container.command).toEqual(["node", "/minter/main.ts"]);
    expect(container.env).toEqual(
      expect.arrayContaining([
        { name: "MINTER_TEAMS", value: "platform,payments" },
        { name: "MINTER_API_KEYS_NAMESPACE", value: "agentgateway-system" },
        { name: "MINTER_API_KEYS_CONFIGMAP", value: "agent-api-keys" },
      ]),
    );
    expect(container.securityContext).toMatchObject({ runAsNonRoot: true, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false });
    expect(pod.volumes).toEqual([{ name: "src", configMap: { name: "minter-src" } }]);
    expect(container.volumeMounts).toEqual([{ name: "src", mountPath: "/minter", readOnly: true }]);
  });

  it("refuses a minter image that is not pinned by digest", () => {
    const r = renderTeams({ ...VALUES, minter: { ...VALUES.minter, image: "node:24-slim" } });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/minter/);
  });
});

describe("keyed model route", () => {
  const gateway = parseAllDocuments(readFileSync(join(PLATFORM_DIR, "gateway.yaml"), "utf8")).map((d) => d.toJS() as K8sObject);

  it("the model route requires a key from the minter's ConfigMap", () => {
    const keys = find(gateway, "ConfigMap", "agent-api-keys", "agentgateway-system")!;
    expect(keys).toBeDefined();
    // The minter owns the entries: re-applying gateway.yaml must not wipe them.
    expect(keys.data).toBeUndefined();

    const policy = gateway.find((o) => o.kind === "AgentgatewayPolicy" && o.spec.targetRefs?.some((t: { kind: string; name: string }) => t.kind === "HTTPRoute" && t.name === "opencode-go"))!;
    expect(policy, "a policy on HTTPRoute opencode-go").toBeDefined();
    expect(policy.metadata.namespace).toBe("agentgateway-system");
    const auth = policy.spec.traffic.apiKeyAuthentication;
    expect(auth.mode).toBe("Strict");
    expect(auth.configMapSelector.matchLabels).toEqual(keys.metadata.labels);
  });
});

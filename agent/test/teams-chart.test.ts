// The teams chart (platform/charts/teams) is what make up installs from the team list:
// each team's namespace and team base, its Argo CD AppProject, and the one ApplicationSet.
import { describe, expect, it } from "vitest";
import { find, render, TEAMS_CHART, valuesFile } from "./chart-helpers.ts";

const REPO = "https://github.com/dackota/build-coding-agent.git";
const WORKER = "ghcr.io/kagent-dev/substrate/ateworker-gvisor:v0.6.0-alpha3@sha256:56e6231c3ed48d54afd3068b6313a1545df1277e0ac1faa6090085cc480d573e";
const VALUES = { teams: ["platform", "payments"], workerImage: WORKER, gitops: { repoURL: REPO, revision: "main" } };

const renderTeams = (values: unknown = VALUES) => render(TEAMS_CHART, "teams", "argocd", [valuesFile(values)]);

describe("teams chart", () => {
  it("renders the team base for each listed team", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    for (const team of ["platform", "payments"]) {
      const ns = `team-${team}`;
      expect(find(r.objects, "Namespace", ns), ns).toBeDefined();
      expect(find(r.objects, "ServiceAccount", "team-default", ns), ns).toBeDefined();
      const pool = find(r.objects, "WorkerPool", "team-default", ns)!;
      expect(pool.spec.workerImage).toBe(WORKER);
      expect(pool.spec.template).toEqual({ serviceAccountName: "team-default" });
      expect(pool.metadata.labels).toEqual({ "kagent.dev/worker-pool-name": "team-default", "kagent.dev/worker-pool-namespace": ns });
      const model = find(r.objects, "ModelConfig", "default-model-config", ns)!;
      expect(model.spec.model).toBe("glm-5.3-flash");
      expect(model.spec.openAI.baseUrl).toBe("http://agentgateway-proxy.agentgateway-system.svc.cluster.local/v1");
      expect(find(r.objects, "Secret", model.spec.apiKeySecret, ns), ns).toBeDefined();
      const harness = find(r.objects, "Harness", "kagent-stock", ns)!;
      expect(harness.spec.kagent).toEqual({});
      expect(harness.spec.substrate.workerPoolRef).toEqual({ name: "team-default" });
    }
  });

  it("each team's AppProject allows only this repo, only its namespace, and no cluster-scoped kinds", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    const project = find(r.objects, "AppProject", "team-payments", "argocd")!;
    expect(project.spec.sourceRepos).toEqual([REPO]);
    expect(project.spec.destinations).toEqual([{ server: "https://kubernetes.default.svc", namespace: "team-payments" }]);
    expect(project.spec.clusterResourceWhitelist).toEqual([]);
    // Teams deploy only what the values-file chart renders; the team base stays platform-owned.
    expect(project.spec.namespaceResourceWhitelist).toEqual([
      { group: "api.kagent.dev", kind: "AgentTemplate" },
      { group: "api.kagent.dev", kind: "Agent" },
      { group: "api.kagent.dev", kind: "ModelConfig" },
      { group: "api.kagent.dev", kind: "Harness" },
      { group: "", kind: "ConfigMap" },
    ]);
  });

  it("renders one ApplicationSet that makes an Application per deployments/<team>/<agent> folder into team-<team>", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    const sets = r.objects.filter((o) => o.kind === "ApplicationSet");
    expect(sets).toHaveLength(1);
    const set = sets[0]!;
    expect(set.metadata.namespace).toBe("argocd");
    expect(set.spec.goTemplate).toBe(true);
    expect(set.spec.generators).toEqual([{ git: { repoURL: REPO, revision: "main", directories: [{ path: "deployments/*/*" }] } }]);
    const tpl = set.spec.template;
    expect(tpl.metadata.name).toBe("{{index .path.segments 1}}-{{.path.basename}}");
    expect(tpl.spec.project).toBe("team-{{index .path.segments 1}}");
    expect(tpl.spec.source).toEqual({
      repoURL: REPO,
      targetRevision: "main",
      path: "platform/charts/agent",
      helm: { releaseName: "{{.path.basename}}", valueFiles: ["../../../{{.path.path}}/values.yaml"], valuesObject: { platform: { skillImages: {} } } },
    });
    expect(tpl.spec.destination).toEqual({ server: "https://kubernetes.default.svc", namespace: "team-{{index .path.segments 1}}" });
  });

  it("ApplicationSet prunes: automated sync with prune and the cascade finalizer", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    const tpl = r.objects.find((o) => o.kind === "ApplicationSet")!.spec.template;
    expect(tpl.metadata.finalizers).toEqual(["resources-finalizer.argocd.argoproj.io"]);
    expect(tpl.spec.syncPolicy.automated).toEqual({ prune: true, selfHeal: true });
  });

  it("tracks the revision it is given, so a branch can be tried before merge", () => {
    const r = renderTeams({ ...VALUES, gitops: { repoURL: REPO, revision: "try/my-agent" } });
    expect(r.ok, r.output).toBe(true);
    const set = r.objects.find((o) => o.kind === "ApplicationSet")!;
    expect(set.spec.generators[0].git.revision).toBe("try/my-agent");
    expect(set.spec.template.spec.source.targetRevision).toBe("try/my-agent");
  });

  it("renders the subagent templates, catalog RemoteMCPServers and git and npm EgressPolicies in each team base", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    for (const team of ["platform", "payments"]) {
      const ns = `team-${team}`;
      for (const sub of ["explorer", "executor", "reviewer"]) {
        const template = find(r.objects, "AgentTemplate", `${sub}-template`, ns)!;
        expect(template, `${ns} ${sub}`).toBeDefined();
        expect(template.spec.systemPrompt, `${ns} ${sub}`).toBeTruthy();
        expect(find(r.objects, "ModelConfig", template.spec.modelConfig.name, ns), `${ns} ${sub} model`).toBeDefined();
      }
      expect(find(r.objects, "RemoteMCPServer", "github-mcp", ns)!.spec.url).toBe("http://github-mcp.github-mcp.svc.cluster.local:8080/");
      expect(find(r.objects, "RemoteMCPServer", "github-mcp", ns)!.spec.headersFrom).toEqual([
        { name: "Authorization", valueFrom: { type: "Secret", name: "github-mcp-token", key: "token" } },
      ]);
      expect(find(r.objects, "RemoteMCPServer", "demo-mcp", ns)!.spec.url).toBe("http://demo-mcp.demo-mcp.svc.cluster.local:8080/mcp");
      expect(find(r.objects, "EgressPolicy", "git-egress", ns)!.spec.destinations).toEqual([
        { origin: "https://github.com" },
        { origin: "https://codeload.github.com" },
      ]);
      expect(find(r.objects, "EgressPolicy", "npm-egress", ns)!.spec.destinations).toEqual([{ origin: "https://registry.npmjs.org" }]);
    }
  });

  it("renders no coding Harness until make deploy pins the image", () => {
    const r = renderTeams();
    expect(r.ok, r.output).toBe(true);
    expect(r.objects.filter((o) => o.kind === "Harness" && o.metadata.name === "coding")).toEqual([]);
  });

  it("renders the coding Harness by digest once make deploy pins it", () => {
    const image = `172.18.0.3:5000/hello-agent@sha256:${"b".repeat(64)}`;
    const r = renderTeams({ ...VALUES, images: { coding: image, skills: {} } });
    expect(r.ok, r.output).toBe(true);
    for (const ns of ["team-platform", "team-payments"]) {
      const harness = find(r.objects, "Harness", "coding", ns)!;
      expect(harness.spec.byo).toEqual({});
      expect(harness.spec.workload).toEqual({ image, command: ["node", "/app/src/main.ts"] });
      expect(harness.spec.substrate.workerPoolRef).toEqual({ name: "team-default" });
    }
  });

  it("rejects a coding image that is not pinned by digest", () => {
    const r = renderTeams({ ...VALUES, images: { coding: "172.18.0.3:5000/hello-agent:latest", skills: {} } });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/coding/);
  });

  it("passes the platform's skill images to every Application", () => {
    const skill = `172.18.0.3:5000/docs-skill@sha256:${"c".repeat(64)}`;
    const r = renderTeams({ ...VALUES, images: { coding: "", skills: { "docs-style": skill } } });
    expect(r.ok, r.output).toBe(true);
    const set = r.objects.find((o) => o.kind === "ApplicationSet")!;
    expect(set.spec.template.spec.source.helm.valuesObject).toEqual({ platform: { skillImages: { "docs-style": skill } } });
  });

  it("rejects a team name in the wrong format", () => {
    const r = renderTeams({ ...VALUES, teams: ["Bad_Team"] });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/teams/);
  });
});

// The catalog MCP servers behind agentgateway (platform/gateway.yaml): one keyed route per
// server, a backend that denies every tool no agent policy allows, and the GitHub token held
// by the GitHub backend only. The minter's per-agent policies target these backends.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { find, type K8sObject, PLATFORM_DIR, render, TEAMS_CHART, valuesFile } from "./chart-helpers.ts";

const NS = "agentgateway-system";
const gateway = parseAllDocuments(readFileSync(join(PLATFORM_DIR, "gateway.yaml"), "utf8")).map((d) => d.toJS() as K8sObject);
// Each catalog server: its route path, backend, and in-cluster service.
const SERVERS = [
  { backend: "github-mcp", path: "/mcp/github", host: "github-mcp.github-mcp.svc.cluster.local", targetPath: "/" },
  { backend: "demo-mcp", path: "/mcp/demo", host: "demo-mcp.demo-mcp.svc.cluster.local", targetPath: "/mcp" },
];
type TargetRef = { group: string; kind: string; name: string };
const targets = (o: K8sObject): TargetRef[] => (o.spec?.targetRefs ?? []) as TargetRef[];
const policiesOn = (kind: string, name: string) => gateway.filter((o) => o.kind === "AgentgatewayPolicy" && targets(o).some((t) => t.kind === kind && t.name === name));

describe("catalog MCP servers behind agentgateway", () => {
  it("each catalog MCP backend is one server, reached by a route under /mcp", () => {
    for (const s of SERVERS) {
      const backend = find(gateway, "AgentgatewayBackend", s.backend, NS)!;
      expect(backend, s.backend).toBeDefined();
      expect(backend.spec.mcp.targets).toEqual([{ name: s.backend, static: { host: s.host, port: 8080, path: s.targetPath, protocol: "StreamableHTTP" } }]);
      const route = find(gateway, "HTTPRoute", s.backend, NS)!;
      expect(route.spec.rules[0].matches).toEqual([{ path: { type: "PathPrefix", value: s.path } }]);
      expect(route.spec.rules[0].backendRefs).toEqual([{ group: "agentgateway.dev", kind: "AgentgatewayBackend", name: s.backend }]);
    }
  });

  it("each catalog MCP route wants an agent key in x-agent-key and strips it", () => {
    const keys = find(gateway, "ConfigMap", "agent-api-keys", NS)!;
    for (const s of SERVERS) {
      const route = find(gateway, "HTTPRoute", s.backend, NS)!;
      expect(route.spec.rules[0].filters).toEqual([{ type: "RequestHeaderModifier", requestHeaderModifier: { remove: ["x-agent-key"] } }]);
      const [policy, ...more] = policiesOn("HTTPRoute", s.backend);
      expect(more, s.backend).toEqual([]);
      expect(policy!.spec.traffic.apiKeyAuthentication).toEqual({ mode: "Strict", location: { header: { name: "x-agent-key" } }, configMapSelector: { matchLabels: keys.metadata.labels } });
    }
  });

  it("each catalog MCP backend denies by default", () => {
    for (const s of SERVERS) {
      const floor = policiesOn("AgentgatewayBackend", s.backend).find((p) => p.metadata.name === "mcp-deny-floor");
      expect(floor, s.backend).toBeDefined();
      // With any Allow rule configured, a tool no rule allows is hidden; this one allows nothing.
      expect(floor!.spec.backend.mcp.authorization).toEqual({ action: "Allow", policy: { matchExpressions: ["false"] } });
    }
  });

  it("the GitHub MCP backend adds the token from a Secret in agentgateway-system", () => {
    expect(find(gateway, "AgentgatewayBackend", "github-mcp", NS)!.spec.policies).toEqual({ auth: { secretRef: { name: "github-mcp-token" } } });
    expect(find(gateway, "AgentgatewayBackend", "demo-mcp", NS)!.spec.policies).toBeUndefined();
  });

  it("the minter writes its policies for exactly these backends", () => {
    const r = render(TEAMS_CHART, "teams", "argocd", [valuesFile({ teams: ["platform"], workerImage: "w", minter: { image: `node@sha256:${"a".repeat(64)}`, source: { main: "//" } } })]);
    expect(r.ok, r.output).toBe(true);
    const env = find(r.objects, "CronJob", "minter", "platform-system")!.spec.jobTemplate.spec.template.spec.containers[0].env as { name: string; value: string }[];
    expect(env.find((e) => e.name === "MINTER_MCP_BACKENDS")?.value.split(",")).toEqual(SERVERS.map((s) => s.backend));
  });
});

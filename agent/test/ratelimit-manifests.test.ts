// The ratelimit service with its Redis (platform/ratelimit.yaml) and the model route's token
// caps (platform/gateway.yaml): each call is checked against its agent's and its team's cap.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { find, type K8sObject, PLATFORM_DIR } from "./chart-helpers.ts";

/** versions.env's NAME=value lines. */
const versions = Object.fromEntries(
  readFileSync(join(PLATFORM_DIR, "versions.env"), "utf8")
    .split("\n")
    .flatMap((l) => (/^[A-Z_]+=/.test(l) ? [[l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const] : [])),
);
/** The file with its @NAME@ placeholders filled from versions.env, as install.sh does. */
const load = (file: string) => {
  const text = readFileSync(join(PLATFORM_DIR, file), "utf8").replace(/@([A-Z_]+)@/g, (_, name: string) => versions[name] ?? `@${name}@`);
  return parseAllDocuments(text).map((d) => d.toJS() as K8sObject);
};
const NS = "agentgateway-system";
const DIGEST = /@sha256:[a-f0-9]{64}$/;

describe("ratelimit service", () => {
  const objects = load("ratelimit.yaml");

  it("runs the ratelimit service and Redis, by digest, in the gateway's namespace", () => {
    for (const name of ["ratelimit", "redis"]) {
      const d = find(objects, "Deployment", name, NS)!;
      expect(d, name).toBeDefined();
      for (const c of d.spec.template.spec.containers) expect(c.image, name).toMatch(DIGEST);
      expect(find(objects, "Service", name, NS), name).toBeDefined();
    }
    const svc = find(objects, "Service", "ratelimit", NS)!;
    expect(svc.spec.ports.map((p: { port: number }) => p.port)).toContain(8081);
  });

  it("takes both images from versions.env, not from literals", () => {
    expect(readFileSync(join(PLATFORM_DIR, "ratelimit.yaml"), "utf8")).not.toMatch(/image: .*sha256/);
    expect(versions.RATELIMIT_IMAGE).toMatch(DIGEST);
    expect(versions.REDIS_IMAGE).toMatch(DIGEST);
  });

  it("reads its config from a ConfigMap the minter owns, which this file leaves without data", () => {
    const cm = find(objects, "ConfigMap", "ratelimit-config", NS)!;
    expect(cm).toBeDefined();
    expect(cm.data).toBeUndefined();
    const pod = find(objects, "Deployment", "ratelimit", NS)!.spec.template.spec;
    expect(pod.volumes).toEqual(expect.arrayContaining([expect.objectContaining({ configMap: expect.objectContaining({ name: "ratelimit-config" }) })]));
    const env = Object.fromEntries(pod.containers[0].env.map((e: { name: string; value?: string }) => [e.name, e.value]));
    expect(env.REDIS_URL).toMatch(/^redis\.agentgateway-system/);
    expect(env.RUNTIME_SUBDIRECTORY).toBeDefined();
  });
});

describe("token caps on the model route", () => {
  const policy = load("gateway.yaml").find((o) => o.kind === "AgentgatewayPolicy" && o.metadata.name === "opencode-go-keys")!;

  it("rate-limits tokens per agent and per team at the ratelimit service, failing closed", () => {
    const global = policy.spec.traffic.rateLimit.global;
    expect(global.backendRef).toMatchObject({ name: "ratelimit", port: 8081 });
    expect(global.domain).toBe("agw");
    expect(global.failureMode).toBe("FailClosed");
    expect(global.descriptors).toEqual([
      { unit: "Tokens", entries: [{ name: "agent", expression: 'apiKey.team + "." + apiKey.agent' }] },
      { unit: "Tokens", entries: [{ name: "team", expression: "apiKey.team" }] },
    ]);
  });

  it("keeps the key requirement", () => {
    expect(policy.spec.traffic.apiKeyAuthentication.mode).toBe("Strict");
  });
});

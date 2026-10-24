// runtime: byo in the values-file chart: the image is pinned by digest on the allowed
// registry (on kind, the local one on the kind network), and the chart renders a Harness
// for it in the team namespace.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AGENT_CHART, find, REPO_ROOT, render, valuesFile } from "./chart-helpers.ts";

const NS = "team-platform";
const DIGEST = "a".repeat(64);
const IMAGE = `172.18.0.3:5000/byo-starter@sha256:${DIGEST}`;
const BYO = {
  name: "byo-starter",
  team: "platform",
  owner: "dackota",
  description: "A byo agent",
  runtime: "byo",
  image: IMAGE,
  command: ["node", "/app/src/main.ts"],
  model: "glm-5.3-flash",
  systemPrompt: "You are a concise assistant. Reply briefly.",
  tokenCap: 1_000_000,
};
const renderByo = (values: unknown) => render(AGENT_CHART, "byo-starter", NS, [valuesFile(values)]);

describe("agent chart: byo runtime", () => {
  it("renders a Harness in the team namespace that runs the image by digest, and an Agent that uses it", () => {
    const r = renderByo(BYO);
    expect(r.ok, r.output).toBe(true);
    const harness = find(r.objects, "Harness", "byo-starter", NS)!;
    expect(harness.apiVersion).toBe("api.kagent.dev/v1alpha3");
    expect(harness.spec).toEqual({
      byo: {},
      workload: { image: IMAGE, command: ["node", "/app/src/main.ts"] },
      substrate: { workerPoolRef: { name: "team-default" }, snapshotPolicy: { location: "gs://ate-snapshots/kagent/" } },
    });
    expect(find(r.objects, "Agent", "byo-starter", NS)!.spec.harnessRef).toEqual({ name: "byo-starter" });
  });

  it("gives a byo agent the same key, cap and tool list as a coding agent", () => {
    const tools = ["github-read", { name: "github-write" }];
    const byo = renderByo({ ...BYO, tools });
    const coding = render(AGENT_CHART, "byo-starter", NS, [valuesFile({ ...BYO, runtime: "coding", image: undefined, command: undefined, tools })]);
    expect(byo.ok, byo.output).toBe(true);
    expect(coding.ok, coding.output).toBe(true);
    for (const [kind, name] of [["ModelConfig", "byo-starter-model"], ["AgentTemplate", "byo-starter"]] as const) {
      expect(find(byo.objects, kind, name, NS)!.spec, kind).toEqual(find(coding.objects, kind, name, NS)!.spec);
    }
    const registration = find(byo.objects, "ConfigMap", "byo-starter-registration", NS)!;
    expect(registration.data).toEqual({ team: "platform", agent: "byo-starter", owner: "dackota", runtime: "byo", model: "glm-5.3-flash", tokenCap: "1000000" });
  });

  it("the starter's example values file renders", () => {
    const file = join(REPO_ROOT, "templates", "byo-ts", "values.example.yaml");
    expect(existsSync(file), "values.example.yaml exists").toBe(true);
    const example = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const r = renderByo({ ...example, name: "byo-starter" });
    expect(r.ok, r.output).toBe(true);
  });

  it("rejects a tag in place of a digest", () => {
    for (const image of ["172.18.0.3:5000/byo-starter:latest", `172.18.0.3:5000/byo-starter:v1@sha256:${DIGEST}x`, "172.18.0.3:5000/byo-starter@sha256:abc"]) {
      const r = renderByo({ ...BYO, image });
      expect(r.ok, image).toBe(false);
      expect(r.output, image).toMatch(/image/);
    }
  });

  it("rejects a foreign registry", () => {
    for (const image of [`ghcr.io/evil/agent@sha256:${DIGEST}`, `docker.io/library/node@sha256:${DIGEST}`, `8.8.8.8:5000/agent@sha256:${DIGEST}`, `172.18.0.3:6000/agent@sha256:${DIGEST}`]) {
      const r = renderByo({ ...BYO, image });
      expect(r.ok, image).toBe(false);
      expect(r.output, image).toMatch(/image/);
    }
  });

  it("rejects byo with no image", () => {
    const { image: _image, ...noImage } = BYO;
    const r = renderByo(noImage);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/image/);
  });

  // kagent refuses a byo Harness with no workload.command, so the values file must give one.
  it("rejects byo with no command, and command on a non-byo runtime", () => {
    const { command: _command, ...noCommand } = BYO;
    expect(renderByo(noCommand).ok).toBe(false);
    for (const runtime of ["stock", "coding"]) {
      const { image: _image, ...rest } = BYO;
      const r = renderByo({ ...rest, runtime });
      expect(r.ok, runtime).toBe(false);
      expect(r.output, runtime).toMatch(/command/);
    }
  });

  it("rejects image on a non-byo runtime", () => {
    for (const runtime of ["stock", "coding"]) {
      const r = renderByo({ ...BYO, runtime });
      expect(r.ok, runtime).toBe(false);
      expect(r.output, runtime).toMatch(/image/);
    }
  });
});

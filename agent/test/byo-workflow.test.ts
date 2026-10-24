// The reusable workflow that builds a byo image, pushes it, and prints its digest.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "./chart-helpers.ts";

const FILE = join(REPO_ROOT, ".github", "workflows", "build-byo-image.yml");
const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
type Job = { steps: { uses?: string }[]; outputs?: Record<string, string>; permissions?: unknown };
type Workflow = { on?: { workflow_call?: { inputs?: Record<string, { required?: boolean }>; outputs?: Record<string, { value: string }> } }; jobs: Record<string, Job> };
const wf = (text ? parse(text) : {}) as Workflow;

describe("build-byo-image.yml", () => {
  it("is callable from another workflow (workflow_call) with a context and an image name", () => {
    const call = wf.on?.workflow_call;
    expect(call?.inputs?.context?.required).toBe(true);
    expect(call?.inputs?.image?.required).toBe(true);
  });

  it("outputs the digest of the pushed image", () => {
    const out = wf.on?.workflow_call?.outputs?.digest;
    expect(out?.value).toMatch(/\$\{\{\s*jobs\.\w+\.outputs\.digest\s*\}\}/);
    const job = wf.jobs[/jobs\.(\w+)\.outputs/.exec(out!.value)![1]!];
    expect(job?.outputs?.digest).toMatch(/steps\.\w+\.outputs\.digest/);
  });

  it("prints the digest as the line to paste into a values file", () => {
    expect(text).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(text).toMatch(/image: .*@/);
  });

  it("pins every action by commit sha and gives the job only the permissions it needs", () => {
    const uses = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter((u): u is string => Boolean(u)));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/@[a-f0-9]{40}$/);
    const job = Object.values(wf.jobs)[0]!;
    expect(job.permissions).toEqual({ contents: "read", packages: "write" });
  });
});

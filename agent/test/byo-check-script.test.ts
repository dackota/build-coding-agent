// platform/byo-check.sh with a stand-in kubectl: what it applies, what it prints, and that
// the throwaway namespace is deleted on every exit path.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./chart-helpers.ts";
import { fakeBin } from "./helpers.ts";

const SCRIPT = join(REPO_ROOT, "platform", "byo-check.sh");
const IMAGE = "172.18.0.3:5000/my-agent@sha256:" + "a".repeat(64);

const KUBECTL = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls.log"
args="$*"
case "$args" in
  *"delete namespace"*) touch "$STUB_DIR/deleted"; exit 0 ;;
  *"get namespace"*) if [ -e "$STUB_DIR/deleted" ] && [ -z "\${STUB_KEEP_NS:-}" ]; then exit 1; fi; exit 0 ;;
  *"apply"*) cat >> "$STUB_DIR/applied.yaml"; if [ -n "\${STUB_FAIL_APPLY:-}" ]; then echo "apply failed" >&2; exit 1; fi; exit 0 ;;
  *"jsonpath={.status.phase}"*) echo "\${STUB_PHASE:-Succeeded}"; exit 0 ;;
  *"jsonpath={.status.podIP}"*) echo "10.244.0.9"; exit 0 ;;
  *logs*) cat "$STUB_DIR/report.txt"; exit 0 ;;
  *) exit 0 ;;
esac
`;

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "byo-check-script-"));
  const bin = fakeBin("kubectl", KUBECTL);
  writeFileSync(join(dir, "report.txt"), "PASS  1  A2A over gRPC\nbyo-check: PASSED\n");
  const res = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "", STUB_DIR: dir, BYO_CHECK_CHECKER_IMAGE: "localhost:5001/byo-checker@sha256:" + "b".repeat(64), BYO_CHECK_POLL_SECONDS: "0", ...(env as Record<string, string>) },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { status: res.status, out: res.stdout + res.stderr, calls: read("calls.log"), applied: read("applied.yaml") };
}

describe("byo-check.sh", () => {
  it("prints the checker's report and exits 0 when the checker pod succeeds", () => {
    const r = run([IMAGE]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("byo-check: PASSED");
  });

  it("exits non-zero and still prints the report when the checker pod fails", () => {
    const r = run([IMAGE], { STUB_PHASE: "Failed" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("A2A over gRPC");
  });

  it("deletes the throwaway namespace after a pass, a fail, and an apply error", () => {
    for (const env of [{}, { STUB_PHASE: "Failed" }, { STUB_FAIL_APPLY: "1" }]) {
      const r = run([IMAGE], env);
      expect(r.calls, JSON.stringify(env)).toMatch(/delete namespace byo-check-[a-z0-9]+/);
    }
  });

  it("fails when the namespace is still there after the delete", () => {
    const r = run([IMAGE], { STUB_KEEP_NS: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/left behind|still exists/i);
  });

  it("runs the image under test as a pod in the throwaway namespace, by the registry address nodes pull from", () => {
    const r = run([IMAGE]);
    expect(r.applied).toContain("localhost:5001/my-agent@sha256:" + "a".repeat(64));
    expect(r.applied).toMatch(/namespace: byo-check-[a-z0-9]+/);
    expect(r.applied).toMatch(/OPENAI_API_KEY/);
    expect(r.applied).toContain("/run/kagent/identity");
  });

  it("passes --context to every kubectl call", () => {
    const r = run([IMAGE]);
    const lines = r.calls.trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((l) => l.startsWith("--context kind-build-coding-agent "))).toBe(true);
  });

  it("refuses a missing or malformed IMAGE before touching the cluster", () => {
    for (const args of [[], ["not an image"]]) {
      const r = run(args);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/usage|IMAGE/);
      expect(r.calls).toBe("");
    }
  });
});

it("make byo-check IMAGE=... runs the script with the image", () => {
  const res = spawnSync("make", ["-n", "-C", REPO_ROOT, "byo-check", `IMAGE=${IMAGE}`], { encoding: "utf8" });
  expect(res.status).toBe(0);
  expect(res.stdout).toContain(`platform/byo-check.sh "${IMAGE}"`);
});

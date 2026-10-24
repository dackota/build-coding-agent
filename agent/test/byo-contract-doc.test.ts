// docs/byo-contract.md lists every rule a byo image must meet, each with why kagent needs it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./chart-helpers.ts";

const DOC = join(REPO_ROOT, "docs", "byo-contract.md");
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
const sections = doc.split(/^## /m).slice(1);

const RULES: [string, RegExp][] = [
  ["A2A over gRPC", /A2A over gRPC/i],
  ["bind 0.0.0.0:80", /0\.0\.0\.0:80/],
  ["open the port before /readyz", /before \/readyz/i],
  ["task store calls to the control-plane URL with the placeholder bearer", /control-plane URL.*placeholder bearer/i],
  ["settle only at real boundaries", /settle only at real boundaries/i],
  ["read the runtime config", /read the runtime config/i],
  ["run subagents and MCP tools itself", /subagents and MCP tools itself/i],
  ["send HITL pauses", /HITL pauses/i],
  ["honor the egress trust bundle", /egress trust bundle/i],
];

describe("docs/byo-contract.md", () => {
  it.each(RULES)("names the rule %s in a section of its own with why kagent needs it", (_name, heading) => {
    const section = sections.find((s) => heading.test(s.split("\n")[0]!));
    expect(section, `no section headed ${heading}`).toBeDefined();
    expect(section).toMatch(/\*\*Why kagent needs it:\*\* \S/);
  });
});

// make chat TEAM=<team> AGENT=<agent> sends the message to <agent> in team-<team>: the
// path a values-file agent is reachable at once Argo CD deploys it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./chart-helpers.ts";

/** A controller that records each request path and answers 500, so the CLI exits after one call. */
async function recordingController() {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(500);
      res.end("recorded");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths, close: () => { server.close(); server.closeAllConnections(); } };
}

async function makeChat(url: string, vars: string[]): Promise<number | null> {
  const child = spawn("make", ["-s", "-C", REPO_ROOT, "chat", "MSG=hello", ...vars], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", KAGENT_URL: url },
    stdio: "ignore",
  });
  return new Promise((r) => child.once("exit", (code) => r(code)));
}

it("make chat TEAM=platform AGENT=x talks to agent x in team-platform", async () => {
  const controller = await recordingController();
  await makeChat(controller.url, ["TEAM=platform", "AGENT=tracer"]);
  controller.close();
  expect(controller.paths[0]).toBe("/agents/team-platform/tracer");
});

it("plain make chat still talks to hello-agent in namespace agents", async () => {
  const controller = await recordingController();
  await makeChat(controller.url, []);
  controller.close();
  expect(controller.paths[0]).toBe("/agents/agents/hello-agent");
});

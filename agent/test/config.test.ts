import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig, loadConfigFromEnv } from "../src/config.ts";

function write(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.json");
  writeFileSync(path, content);
  return path;
}

it("reads the model name, gateway base URL, and instruction from the kagent config file", () => {
  const cfg = loadConfig(
    write(JSON.stringify({ agent: { model: { model: "glm-5", openai: { base_url: "http://gw/v1" } }, instruction: "Be brief." } })),
  );
  expect(cfg).toEqual({ model: "glm-5", baseUrl: "http://gw/v1", instruction: "Be brief." });
});

it("fails with a clear message when the model or base URL is missing", () => {
  expect(() => loadConfig(write(JSON.stringify({ agent: { model: { model: "x" } } })))).toThrow(/base_url/);
  expect(() => loadConfig(write("not json"))).toThrow(/config/i);
});

it("prefers KAGENT_CONFIG_JSON in the environment over the file path", () => {
  const json = JSON.stringify({ agent: { model: { model: "m", openai: { base_url: "http://gw/v1" } }, instruction: "i" } });
  expect(loadConfigFromEnv({ KAGENT_CONFIG_JSON: json, KAGENT_CONFIG_PATH: "/nonexistent" })).toEqual({
    model: "m",
    baseUrl: "http://gw/v1",
    instruction: "i",
  });
});

it("never puts config values in an error, only key names", () => {
  const secret = "sk-secret-value-123";
  const bad = JSON.stringify({ agent: { model: { model: "m", openai: { api_key: secret } } } });
  try {
    loadConfigFromEnv({ KAGENT_CONFIG_JSON: bad });
    expect.unreachable();
  } catch (err) {
    expect((err as Error).message).not.toContain(secret);
    expect((err as Error).message).toContain("api_key");
  }
});

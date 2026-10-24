import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * A chat model reached through the gateway at `baseUrl` (with /v1). The model route wants the
 * agent's own key; the actor holds only kagent's placeholder in OPENAI_API_KEY, sent as a
 * Bearer token, and Substrate's egress gateway swaps in the real key as the call leaves.
 * With no OPENAI_API_KEY (local runs) no Authorization is sent.
 * Mirrored by templates/byo-ts/src/model.ts: change the key rule in both.
 */
export function gatewayModel(baseUrl: string, model: string, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const apiKey = env.OPENAI_API_KEY || undefined;
  return createOpenAICompatible({ name: "gateway", baseURL: baseUrl, apiKey }).chatModel(model);
}

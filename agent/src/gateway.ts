import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/** A chat model reached through the gateway at `baseUrl` (with /v1). The gateway holds the key. */
export function gatewayModel(baseUrl: string, model: string) {
  return createOpenAICompatible({ name: "gateway", baseURL: baseUrl }).chatModel(model);
}

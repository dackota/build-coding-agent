import type { ExtensionApi } from "../../../src/extensions.ts";
import { planHandler } from "../plan-handler.ts";

export default function (api: ExtensionApi): void {
  api.on("tool_call", planHandler(3));
}

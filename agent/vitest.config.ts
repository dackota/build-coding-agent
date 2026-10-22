import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Seam-1 tests start the agent as a child process; a cold node start can take seconds.
    testTimeout: 30_000,
  },
});

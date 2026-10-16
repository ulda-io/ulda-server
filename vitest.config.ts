import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "test/e2e/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});

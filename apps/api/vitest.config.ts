import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/content.test.ts",
      "test/sdk.test.ts",
      "test/shared.test.ts",
      "test/unit.test.ts",
    ],
    exclude: configDefaults.exclude,
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["test/**/*.ts"],
    },
  },
})

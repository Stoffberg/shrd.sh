import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    hookTimeout: 120000,
    testTimeout: 120000,
    pool: "forks",
    forks: {
      singleFork: true,
    },
  },
})

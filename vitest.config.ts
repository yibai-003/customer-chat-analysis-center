import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    maxWorkers: 4,
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
  },
});

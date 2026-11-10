import { defineConfig } from "vitest/config";

// Vitest's default pattern matches a test file anywhere below the root, also in
// untracked evaluation artifacts such as eval/results/. Only test/ holds tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,mjs}"],
  },
});

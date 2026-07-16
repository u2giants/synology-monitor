import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the TypeScript sources are the tests. Without this, a stale dist/ left by
    // `tsc` gets collected too, and the compiled duplicates run against a snapshot of
    // the builder rather than the current source — green tests, meaningless.
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});

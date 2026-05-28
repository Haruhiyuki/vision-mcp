// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/tests/**/*.test.ts"],
    setupFiles: [],
    pool: "forks",
    isolate: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts"],
    },
  },
  resolve: {
    alias: {
      "@vision-mcp/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@vision-mcp/server": new URL("./packages/server/src/index.ts", import.meta.url).pathname,
    },
  },
});

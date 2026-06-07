// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliVersion, main, usage } from "../src/cli";

describe("CLI global metadata flags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the package version for --version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["--version"]);

    expect(log).toHaveBeenCalledWith(cliVersion());
  });

  it("prints the package version for -v", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["-v"]);

    expect(log).toHaveBeenCalledWith(cliVersion());
  });

  it("keeps top-level help available", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["--help"]);

    expect(log).toHaveBeenCalledWith(usage());
  });
});

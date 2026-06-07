import { expect, test, describe } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const cliPath = path.resolve(__dirname, "..", "dist", "index.js");

describe("Vision-MCP CLI global flags", () => {
  test("--version prints correct version", () => {
    const result = spawnSync("node", [cliPath, "--version"], { encoding: "utf8", shell: true });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("-v prints correct version", () => {
    const result = spawnSync("node", [cliPath, "-v"], { encoding: "utf8", shell: true });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("--help contains version info", () => {
    const result = spawnSync("node", [cliPath, "--help"], { encoding: "utf8", shell: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("-v, --version");
  });
});

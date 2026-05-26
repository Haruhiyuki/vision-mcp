import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { VisionMap } from "../schema/map.js";
import { Patch } from "../schema/patch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const outDir = path.join(repoRoot, "schema");
  await fs.mkdir(outDir, { recursive: true });

  const mapSchema = zodToJsonSchema(VisionMap, {
    name: "VisionMap",
    $refStrategy: "root",
    target: "jsonSchema7",
  });
  const patchSchema = zodToJsonSchema(Patch, {
    name: "Patch",
    $refStrategy: "root",
    target: "jsonSchema7",
  });

  const mapPath = path.join(outDir, "vision-mcp.schema.json");
  const patchPath = path.join(outDir, "vision-mcp-patch.schema.json");
  await fs.writeFile(mapPath, JSON.stringify(mapSchema, null, 2), "utf8");
  await fs.writeFile(patchPath, JSON.stringify(patchSchema, null, 2), "utf8");

  console.log(`Wrote ${mapPath}`);
  console.log(`Wrote ${patchPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

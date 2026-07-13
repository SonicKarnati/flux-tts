import * as esbuild from "esbuild";
import { rm } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

const outdir = ".test-dist";
await rm(outdir, { recursive: true, force: true });
const entryPoints = [];
for await (const file of glob("tests/*.test.ts")) entryPoints.push(file);
await esbuild.build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir,
  outExtension: { ".js": ".cjs" }
});
const outputFiles = entryPoints.map((file) => join(outdir, basename(file, ".ts") + ".cjs"));
const result = spawnSync(process.execPath, ["--test", ...outputFiles], { stdio: "inherit" });
await rm(outdir, { recursive: true, force: true });
process.exitCode = result.status ?? 1;

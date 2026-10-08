/**
 * T1 检索评测 runner：
 * 1. 用 esbuild 把 retrieval-entry.ts 打成 ESM（alias obsidian → obsidian-mock.ts）
 * 2. node 执行 bundle，输出 docs/evaluation/retrieval-eval-result.json
 */
import { build } from "esbuild";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const outfile = join(__dirname, "retrieval-entry.bundle.mjs");

await build({
  entryPoints: [join(__dirname, "retrieval-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  alias: {
    obsidian: join(__dirname, "obsidian-mock.ts"),
  },
  logLevel: "warning",
});

await import(pathToFileURL(outfile).href);

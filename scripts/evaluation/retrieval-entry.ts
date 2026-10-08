/**
 * T1 检索评测入口：对 gold set 逐题跑现有两阶段词法检索。
 * 通过 esbuild alias 使用 obsidian-mock.ts 替代 obsidian 模块。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeScopeRetriever } from "../../src/knowledge-scope";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const VAULT_ROOT = join(repoRoot, "docs", "evaluation", "vault");
const GOLD_SET_PATH = join(repoRoot, "docs", "evaluation", "gold-set.json");
const RESULT_PATH = join(repoRoot, "docs", "evaluation", "retrieval-eval-result.json");
const SCOPE_PREFIX = "vault";
const FIXED_MTIME = 1_700_000_000_000;

// knowledge-scope.ts 索引构建里用了 window.setTimeout
(globalThis as Record<string, unknown>).window = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
};

interface GoldQuestion {
  id: string;
  type: "concept" | "howto" | "comparison" | "lookup";
  synonym_rewrite: boolean;
  question: string;
  expected: { path: string; heading: string };
}

interface EvalResult {
  id: string;
  type: string;
  synonym_rewrite: boolean;
  question: string;
  expected_path: string;
  expected_heading: string;
  search3_paths: string[];
  search3_hit: boolean;
  search6_rank: number | null;
  read_heading: string | null;
  final_hit: boolean;
  reasons: string[];
}

function collectMarkdown(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    const rel = prefix ? `${prefix}/${name.name}` : name.name;
    if (name.isDirectory()) out.push(...collectMarkdown(full, rel));
    else if (name.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

function parseFrontmatter(markdown: string): Record<string, unknown> | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const data: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = raw
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (raw) {
      data[key] = raw;
    }
  }
  return data;
}

function buildMockApp() {
  const files = collectMarkdown(VAULT_ROOT).map((rel) => {
    const path = `${SCOPE_PREFIX}/${rel.replace(/\\/g, "/")}`;
    const basename = rel.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
    return { path, basename, stat: { mtime: FIXED_MTIME } };
  });
  const contents = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  for (const file of files) {
    const rel = file.path.slice(SCOPE_PREFIX.length + 1);
    const markdown = readFileSync(join(VAULT_ROOT, rel), "utf8");
    contents.set(file.path, markdown);
    const frontmatter = parseFrontmatter(markdown);
    const headings: Array<{ heading: string }> = [];
    const links: Array<{ link: string }> = [];
    for (const line of markdown.split(/\r?\n/)) {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) headings.push({ heading: heading[1].trim() });
    }
    for (const match of markdown.matchAll(/\[\[([^\]]+)\]\]/g)) {
      links.push({ link: match[1] });
    }
    metadata.set(file.path, { headings, tags: [], links, embeds: [], frontmatter });
  }
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => metadata.get(file.path) ?? null,
    },
  };
  return app as never;
}

function extractHeadingFromBlock(block: string): string | null {
  // Source 行格式：Source: [[path#heading|basename › heading]] 或 [[path|basename]]
  const sourceLine = block.split("\n")[0];
  const match = sourceLine.match(/#([^|\]]+)\|/);
  return match ? match[1].trim() : null;
}

async function evaluate() {
  const goldSet = JSON.parse(readFileSync(GOLD_SET_PATH, "utf8")) as {
    questions: GoldQuestion[];
  };
  const app = buildMockApp();
  const results: EvalResult[] = [];

  for (const item of goldSet.questions) {
    const expectedPath = `${SCOPE_PREFIX}/${item.expected.path}`;
    // 工具口径：search(query, 3) → read(全部 refs)，与 RetrieveKnowledgeEvidence 一致
    const retriever = new KnowledgeScopeRetriever({
      app,
      scopePath: SCOPE_PREFIX,
      currentFilePath: "",
    });
    const search3 = await retriever.search(item.question, 3);
    const search3Hit = search3.some((r) => r.path === expectedPath);
    let readHeading: string | null = null;
    if (search3Hit) {
      const evidence = await retriever.read(search3.map((r) => r.sourceRef));
      for (const block of evidence.split("\n\n---\n\n")) {
        const sourceLine = block.split("\n")[0] ?? "";
        const pathMatch = sourceLine.match(/\[\[([^\]|#]+)[#\]|]/);
        if (pathMatch && pathMatch[1] === expectedPath) {
          readHeading = extractHeadingFromBlock(block);
          break;
        }
      }
    }
    const finalHit = search3Hit && readHeading === item.expected.heading;

    // 参照口径：limit=6 下 gold 文件排名（观察 lane 配额放宽后的文件级召回）
    const retriever6 = new KnowledgeScopeRetriever({
      app,
      scopePath: SCOPE_PREFIX,
      currentFilePath: "",
    });
    const search6 = await retriever6.search(item.question, 6);
    const rank6 = search6.findIndex((r) => r.path === expectedPath);

    const hitEntry = search3.find((r) => r.path === expectedPath);
    results.push({
      id: item.id,
      type: item.type,
      synonym_rewrite: item.synonym_rewrite,
      question: item.question,
      expected_path: item.expected.path,
      expected_heading: item.expected.heading,
      search3_paths: search3.map((r) => r.path.replace(`${SCOPE_PREFIX}/`, "")),
      search3_hit: search3Hit,
      search6_rank: rank6 === -1 ? null : rank6 + 1,
      read_heading: readHeading,
      final_hit: finalHit,
      reasons: hitEntry?.reasons ?? [],
    });
  }

  const summarize = (subset: EvalResult[]) => ({
    count: subset.length,
    final_hit: subset.filter((r) => r.final_hit).length,
    search3_file_hit: subset.filter((r) => r.search3_hit).length,
    search6_file_hit: subset.filter((r) => r.search6_rank !== null).length,
  });
  const byType: Record<string, ReturnType<typeof summarize>> = {};
  for (const type of ["concept", "howto", "comparison", "lookup"]) {
    byType[type] = summarize(results.filter((r) => r.type === type));
  }
  const summary = {
    created: new Date().toISOString(),
    total: summarize(results),
    direct: summarize(results.filter((r) => !r.synonym_rewrite)),
    synonym_rewrite: summarize(results.filter((r) => r.synonym_rewrite)),
    by_type: byType,
    decision_rule: {
      threshold: 0.6,
      metric: "synonym_rewrite.final_hit / synonym_rewrite.count",
      result:
        summarize(results.filter((r) => r.synonym_rewrite)).final_hit /
          results.filter((r) => r.synonym_rewrite).length <
        0.6
          ? "proceed_to_embedding"
          : "keep_lexical_tune_lanes",
    },
    results,
  };

  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
}

evaluate().catch((error) => {
  console.error(error);
  process.exit(1);
});

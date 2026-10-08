import type { App, CachedMetadata, TFile } from "obsidian";
import { normalizePath } from "obsidian";
import { raceWithAbort, throwIfAborted } from "./abort";
import type { AgentRuntimeTool } from "./agent-runtime";
import {
  classifyKnowledgeIdentity,
  type EpistemicStatus,
  type KnowledgeIdentity,
} from "./knowledge-identity";

export const MAX_KNOWLEDGE_SEARCH_CALLS = 2;
export const MAX_KNOWLEDGE_READ_CALLS = 2;
export const MAX_KNOWLEDGE_RETRIEVAL_CALLS = 2;
const MAX_READ_REFS = 3;
const MAX_SCOPE_RESULTS = MAX_KNOWLEDGE_READ_CALLS * MAX_READ_REFS;
const MAX_PASSAGE_CHARACTERS = 6000;
const MAX_TOTAL_READ_CHARACTERS = 16000;
const MAX_INDEX_FILES = 300;
const MAX_INDEX_TOTAL_CHARACTERS = 2_000_000;
const MAX_INDEX_CHARACTERS_PER_FILE = 24_000;
const INDEX_YIELD_EVERY_FILES = 12;

export interface KnowledgeScopeSearchResult {
  sourceRef: string;
  path: string;
  title: string;
  headings: string[];
  tags: string[];
  score: number;
  reasons: string[];
  identity: KnowledgeIdentity;
  epistemicStatus: EpistemicStatus;
}

interface SourceReference {
  file: TFile;
  query: string;
  mtime: number;
  identity: KnowledgeIdentity;
  epistemicStatus: EpistemicStatus;
}

interface ScopeIndexEntry {
  mtime: number;
  text: string;
}

const scopeIndexByApp = new WeakMap<object, Map<string, Map<string, ScopeIndexEntry>>>();

function normalizedPath(value: string) {
  const trimmed = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? normalizePath(trimmed) : "";
}

export function normalizeKnowledgeScopePaths(value: unknown) {
  const paths = Array.isArray(value) ? value : [];
  return [...new Set(paths.map((path) => normalizedPath(String(path))).filter(Boolean))];
}

export function pathIsWithinScope(path: string, scopePath: string) {
  const normalizedFile = normalizedPath(path);
  const normalizedScope = normalizedPath(scopePath);
  return Boolean(
    normalizedScope &&
      (normalizedFile === normalizedScope ||
        normalizedFile.startsWith(`${normalizedScope}/`)),
  );
}

export function findKnowledgeScopeForFile(
  filePath: string,
  scopePaths: string[],
) {
  const normalizedScopes = normalizeKnowledgeScopePaths(scopePaths);
  if (!normalizedScopes.length) {
    const normalizedFile = normalizedPath(filePath);
    const separatorIndex = normalizedFile.lastIndexOf("/");
    return separatorIndex > 0 ? normalizedFile.slice(0, separatorIndex) : "";
  }
  return normalizedScopes
    .filter((scopePath) => pathIsWithinScope(filePath, scopePath))
    .sort((left, right) => right.length - left.length)[0] || "";
}

// 查询停用词（P1 修正）：疑问词/口语衬词会污染词法和 n-gram 打分——
// "Compaction 是什么意思" 里 "什么/是/意思" 的命中把 A01（标题含"是什么"）抬到
// 标题就含 compaction 的 A04 之上（insight 套件 L1-T1 实测）。检索前先剥离。
const QUERY_STOPWORDS = [
  "什么", "怎么", "为什么", "如何", "哪些", "是不是", "有没有", "意思",
  "帮我", "查找", "搜索", "检索", "笔记", "笔记里", "说的", "请问",
  "一下", "还是", "就是", "这个", "那个", "它们", "我们", "你们",
  "what", "how", "why", "mean", "means", "note", "notes", "please",
];

function stripQueryStopwords(value: string) {
  let text = String(value || "");
  for (const stopword of QUERY_STOPWORDS) {
    text = text.split(stopword).join(" ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function queryTerms(value: string) {
  const normalized = stripQueryStopwords(
    String(value || "").normalize("NFKC").toLowerCase(),
  );
  const terms = new Set<string>();
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) || []) {
    terms.add(word);
  }
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (sequence.length <= 8) {
      terms.add(sequence);
    }
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        terms.add(sequence.slice(index, index + size));
      }
    }
  }
  return [...terms].slice(0, 80);
}

function cacheHeadings(cache: CachedMetadata | null) {
  return (cache?.headings || [])
    .map((heading) => String(heading.heading || "").trim())
    .filter(Boolean);
}

function cacheTags(cache: CachedMetadata | null) {
  const tags = new Set<string>();
  for (const tag of cache?.tags || []) {
    if (tag.tag) {
      tags.add(String(tag.tag));
    }
  }
  const frontmatterTags = cache?.frontmatter?.tags;
  for (const tag of Array.isArray(frontmatterTags)
    ? frontmatterTags
    : typeof frontmatterTags === "string"
      ? frontmatterTags.split(/[\s,]+/)
      : []) {
    if (tag) {
      tags.add(String(tag));
    }
  }
  return [...tags];
}

function cacheAliases(cache: CachedMetadata | null) {
  const value = cache?.frontmatter?.aliases || cache?.frontmatter?.alias;
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((alias) => String(alias || "").trim())
    .filter(Boolean);
}

function scoreMetadata(file: TFile, cache: CachedMetadata | null, query: string) {
  const terms = queryTerms(query);
  if (!terms.length) {
    return { score: 0, reasons: [] as string[] };
  }
  const basename = String(file.basename || "").toLowerCase();
  const headings = cacheHeadings(cache).map((heading) => heading.toLowerCase());
  const tags = cacheTags(cache).map((tag) => tag.toLowerCase());
  const aliases = cacheAliases(cache).map((alias) => alias.toLowerCase());
  const links = [...(cache?.links || []), ...(cache?.embeds || [])]
    .map((link) => String(link.link || "").toLowerCase())
    .filter(Boolean);
  let score = 0;
  const reasons = new Set<string>();
  for (const term of terms) {
    if (basename.includes(term)) {
      score += 9;
      reasons.add("filename");
    }
    if (headings.some((heading) => heading.includes(term))) {
      score += 6;
      reasons.add("heading");
    }
    if (aliases.some((alias) => alias.includes(term))) {
      score += 5;
      reasons.add("alias");
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 4;
      reasons.add("tag");
    }
    if (links.some((link) => link.includes(term))) {
      score += 2;
      reasons.add("link");
    }
  }
  return { score, reasons: [...reasons] };
}

function scoreIndexedText(text: string, query: string) {
  let score = 0;
  let matches = 0;
  for (const term of queryTerms(query)) {
    if (text.includes(term)) {
      score += term.length >= 4 ? 3 : 1;
      matches += 1;
    }
    if (matches >= 12) {
      break;
    }
  }
  return Math.min(24, score);
}

// —— 混合检索（P1）：字符 n-gram 余弦相似度 ——
// 纯 includes 词汇匹配无法召回"表述不同但语义相同"的内容（benchmark S02/S04 的根因）。
// 中文按汉字二元组、拉丁按词元切分，余弦归一化天然抗长度偏差；零依赖、离线可用。
// 真正的 embedding 后端（KnowledgeSearchBackend 接口化）留给后续版本，排序权重可直接复用。
export function ngramSimilarity(a: string, b: string) {
  const fa = ngramTermFrequencies(a);
  const fb = ngramTermFrequencies(b);
  if (!fa.size || !fb.size) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [gram, count] of fa) {
    na += count * count;
    const other = fb.get(gram);
    if (other) {
      dot += count * other;
    }
  }
  for (const [, count] of fb) {
    nb += count * count;
  }
  return dot / Math.sqrt(na * nb);
}

function ngramTermFrequencies(text: string) {
  const normalized = String(text || "").toLowerCase().normalize("NFKC");
  const frequencies = new Map<string, number>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9-]{2,}/g) || []) {
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }
  const cjk = normalized.replace(/[^\p{Script=Han}]/gu, "");
  for (let index = 0; index + 2 <= cjk.length; index += 1) {
    const gram = cjk.slice(index, index + 2);
    frequencies.set(gram, (frequencies.get(gram) || 0) + 1);
  }
  return frequencies;
}

// 语义召回门槛：低于该余弦值的候选不进入排序（防止语义分把无关笔记全带进来）
const SEMANTIC_FILE_THRESHOLD = 0.22;
const SEMANTIC_FILE_WEIGHT = 10;
const SEMANTIC_PASSAGE_THRESHOLD = 0.12;
const SEMANTIC_PASSAGE_WEIGHT = 12;

function balanceIdentityLanes<T extends { identity: KnowledgeIdentity; score: number }>(
  candidates: T[],
  limit: number,
) {
  const preferred = candidates.filter(
    (candidate) =>
      candidate.identity === "personal_knowledge" ||
      candidate.identity === "user_curated",
  );
  const external = candidates.filter(
    (candidate) => candidate.identity === "external_material",
  );
  const unknown = candidates.filter((candidate) => candidate.identity === "unknown");
  const preferredQuota = preferred.length
    ? Math.min(preferred.length, Math.max(1, Math.ceil(limit / 2)))
    : 0;
  const externalQuota = external.length
    ? Math.min(external.length, Math.max(1, Math.floor(limit / 3)))
    : 0;
  const unknownQuota = Math.max(0, limit - preferredQuota - externalQuota);
  const selected = [
    ...preferred.slice(0, preferredQuota),
    ...external.slice(0, externalQuota),
    ...unknown.slice(0, unknownQuota),
  ];
  const selectedSet = new Set(selected);
  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }
    if (!selectedSet.has(candidate)) {
      selected.push(candidate);
      selectedSet.add(candidate);
    }
  }
  return selected
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function splitMarkdownPassages(markdown: string) {
  const passages: Array<{ heading: string; content: string }> = [];
  let heading = "";
  let buffer: string[] = [];
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) {
      passages.push({ heading, content });
    }
    buffer = [];
  };
  let inFrontmatter = false;
  let frontmatterDone = false;
  for (const line of String(markdown || "").split(/\r?\n/)) {
    if (!frontmatterDone) {
      if (!inFrontmatter && line.trim() === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter && line.trim() === "---") {
        inFrontmatter = false;
        frontmatterDone = true;
        continue;
      }
      if (inFrontmatter) {
        continue;
      }
    }
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1].trim();
      buffer.push(line);
      continue;
    }
    buffer.push(line);
    if (buffer.join("\n").length >= MAX_PASSAGE_CHARACTERS) {
      flush();
    }
  }
  flush();
  // 跳过纯标题块：去掉标题行后没有实质文本的段落（典型是 H1 标题行，
  // 它与文件名重复计分，会在 scorePassage 中吸走全部命中、挤掉真正的内容段落）。
  return passages.filter((passage) => {
    const body = passage.content
      .split("\n")
      .filter((line) => !/^#{1,6}\s+/.test(line))
      .join("\n")
      .trim();
    return Boolean(body);
  });
}

function scorePassage(passage: { heading: string; content: string }, query: string) {
  const heading = passage.heading.toLowerCase();
  const content = passage.content.toLowerCase();
  let score = 0;
  for (const term of queryTerms(query)) {
    if (heading.includes(term)) {
      score += 6;
    }
    if (content.includes(term)) {
      score += 2;
    }
  }
  const semantic = ngramSimilarity(stripQueryStopwords(query), `${passage.heading} ${passage.content}`);
  if (semantic >= SEMANTIC_PASSAGE_THRESHOLD) {
    score += semantic * SEMANTIC_PASSAGE_WEIGHT;
  }
  // 引文陷阱的处理在 read() 的块级选择处做相对降权（见 read 内注释）
  return score;
}

// 引文陷阱检测：块内包含查询/用户原问的 ≥10 字连续原文（保留原标点与衬词的
// 原文匹配——去停用词后的窗口串无法匹配块内原文，A15 曾因此漏检）。
// 同时检查检索查询与用户原始问题：模型改写过的工具查询会绕开逐字检测，
// 但陷阱块对改写查询依然高分。
function containsAnyQueryQuote(queries: string[], lowercasedText: string) {
  for (const query of queries) {
    const normalized = String(query || "")
      .toLowerCase()
      .replace(/\s+/g, "");
    if (normalized.length < 10) {
      continue;
    }
    const windowSize = 10;
    for (let index = 0; index + windowSize <= normalized.length; index += 2) {
      if (lowercasedText.includes(normalized.slice(index, index + windowSize))) {
        return true;
      }
    }
  }
  return false;
}

function normalizedQuery(value: string) {
  return queryTerms(value).sort().join("|");
}

function contentFingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export class KnowledgeScopeRetriever {
  private app: App;
  private scopePath: string;
  private currentFilePath: string;
  private userQuestion: string;
  private signal?: AbortSignal;
  private nextSourceRef = 1;
  private sourceRefs = new Map<string, SourceReference>();
  private sourceRefByKey = new Map<string, string>();
  private searchCache = new Map<string, KnowledgeScopeSearchResult[]>();
  private markdownCache = new Map<string, { mtime: number; markdown: string }>();
  private passageCache = new Map<string, { block: string; evidenceKey: string }>();
  private emittedEvidenceKeys = new Set<string>();
  private emittedEvidenceTexts: string[] = [];
  private totalReadCharacters = 0;
  private usedSources = new Map<
    string,
    {
      path: string;
      title: string;
      heading?: string;
      identity: KnowledgeIdentity;
      epistemicStatus: EpistemicStatus;
    }
  >();

  constructor(options: {
    app: App;
    scopePath: string;
    currentFilePath?: string;
    userQuestion?: string;
    signal?: AbortSignal;
  }) {
    this.app = options.app;
    this.scopePath = normalizedPath(options.scopePath);
    this.currentFilePath = normalizedPath(options.currentFilePath || "");
    this.userQuestion = String(options.userQuestion || "");
    this.signal = options.signal;
  }

  private async getScopeIndex(files: TFile[]) {
    let appIndexes = scopeIndexByApp.get(this.app);
    if (!appIndexes) {
      appIndexes = new Map();
      scopeIndexByApp.set(this.app, appIndexes);
    }
    let index = appIndexes.get(this.scopePath);
    if (!index) {
      index = new Map();
      appIndexes.set(this.scopePath, index);
    }
    const activePaths = new Set(files.map((file) => file.path));
    for (const path of index.keys()) {
      if (!activePaths.has(path)) {
        index.delete(path);
      }
    }
    let totalCharacters = 0;
    const indexedPaths = new Set<string>();
    const boundedFiles = files.slice(0, MAX_INDEX_FILES);
    for (let indexPosition = 0; indexPosition < boundedFiles.length; indexPosition += 1) {
      throwIfAborted(this.signal, "Local knowledge indexing was cancelled.");
      const remainingCharacters = Math.max(
        0,
        MAX_INDEX_TOTAL_CHARACTERS - totalCharacters,
      );
      if (!remainingCharacters) {
        break;
      }
      const file = boundedFiles[indexPosition];
      const mtime = file.stat?.mtime || 0;
      const cached = index.get(file.path);
      if (!cached || cached.mtime !== mtime) {
        const markdown = await raceWithAbort(
          this.app.vault.cachedRead(file),
          this.signal,
          "Local knowledge indexing was cancelled.",
        );
        index.set(file.path, {
          mtime,
          text: String(markdown || "")
            .normalize("NFKC")
            .toLowerCase()
            .slice(
              0,
              Math.min(MAX_INDEX_CHARACTERS_PER_FILE, remainingCharacters),
            ),
        });
      } else if (cached.text.length > remainingCharacters) {
        index.set(file.path, {
          mtime,
          text: cached.text.slice(0, remainingCharacters),
        });
      }
      indexedPaths.add(file.path);
      totalCharacters += index.get(file.path)?.text.length || 0;
      if ((indexPosition + 1) % INDEX_YIELD_EVERY_FILES === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    for (const path of index.keys()) {
      if (!indexedPaths.has(path)) {
        index.delete(path);
      }
    }
    return index;
  }

  async search(query: string, limit = MAX_SCOPE_RESULTS) {
    throwIfAborted(this.signal, "Local knowledge search was cancelled.");
    const boundedLimit = Math.min(MAX_SCOPE_RESULTS, Math.max(1, limit));
    const searchKey = `${normalizedQuery(query)}:${boundedLimit}`;
    const cachedResults = this.searchCache.get(searchKey);
    if (cachedResults) {
      return cachedResults.map((result) => ({ ...result }));
    }
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          pathIsWithinScope(file.path, this.scopePath) &&
          normalizedPath(file.path) !== this.currentFilePath,
      );
    const index = await this.getScopeIndex(files);
    const candidates = files
      .map((file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        const scored = scoreMetadata(file, cache, query);
        const bodyScore = scoreIndexedText(index.get(file.path)?.text || "", query);
        // 混合检索：词汇命中 + 语义余弦（文件名/标题/别名维度）
        const semanticText = [
          file.basename || "",
          cacheHeadings(cache).join(" "),
          cacheAliases(cache).join(" "),
        ].join(" ");
        const semanticScore = ngramSimilarity(stripQueryStopwords(query), semanticText);
        const semanticBonus =
          semanticScore >= SEMANTIC_FILE_THRESHOLD
            ? semanticScore * SEMANTIC_FILE_WEIGHT
            : 0;
        const identity = classifyKnowledgeIdentity(file, cache);
        return {
          file,
          cache,
          score: scored.score + bodyScore + semanticBonus,
          reasons:
            semanticBonus > 0
              ? [...new Set([...scored.reasons, ...(bodyScore > 0 ? ["body"] : []), "semantic"])]
              : bodyScore > 0
                ? [...scored.reasons, "body"]
                : scored.reasons,
          ...identity,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          (right.file.stat?.mtime || 0) - (left.file.stat?.mtime || 0),
      );
    const balancedCandidates = balanceIdentityLanes(
      candidates,
      boundedLimit,
    );

    const results: KnowledgeScopeSearchResult[] = balancedCandidates.map((candidate) => {
      const mtime = candidate.file.stat?.mtime || 0;
      const referenceKey = `${candidate.file.path}:${mtime}:${normalizedQuery(query)}`;
      let sourceRef = this.sourceRefByKey.get(referenceKey);
      if (!sourceRef) {
        sourceRef = `scope-source-${this.nextSourceRef++}`;
        this.sourceRefByKey.set(referenceKey, sourceRef);
        this.sourceRefs.set(sourceRef, {
          file: candidate.file,
          query,
          mtime,
          identity: candidate.identity,
          epistemicStatus: candidate.epistemicStatus,
        });
      }
      return {
        sourceRef,
        path: candidate.file.path,
        title: candidate.file.basename,
        headings: cacheHeadings(candidate.cache).slice(0, 6),
        tags: cacheTags(candidate.cache).slice(0, 6),
        score: candidate.score,
        reasons: candidate.reasons,
        identity: candidate.identity,
        epistemicStatus: candidate.epistemicStatus,
      };
    });
    this.searchCache.set(searchKey, results.map((result) => ({ ...result })));
    return results;
  }

  async read(sourceRefs: string[]) {
    const uniqueRefs = [...new Set(sourceRefs)].slice(0, MAX_READ_REFS);
    const blocks: string[] = [];
    for (const sourceRef of uniqueRefs) {
      throwIfAborted(this.signal, "Local knowledge reading was cancelled.");
      const reference = this.sourceRefs.get(sourceRef);
      if (!reference) {
        throw new Error(`Unknown or expired local source reference: ${sourceRef}`);
      }
      if (
        !pathIsWithinScope(reference.file.path, this.scopePath) ||
        (reference.file.stat?.mtime || 0) !== reference.mtime
      ) {
        throw new Error(`Local source changed or left the allowed scope: ${sourceRef}`);
      }
      const cachedPassage = this.passageCache.get(sourceRef);
      if (cachedPassage) {
        if (!this.emittedEvidenceKeys.has(cachedPassage.evidenceKey)) {
          this.emittedEvidenceKeys.add(cachedPassage.evidenceKey);
          blocks.push(cachedPassage.block);
          this.emittedEvidenceTexts.push(cachedPassage.block);
        }
        continue;
      }
      const cachedMarkdown = this.markdownCache.get(reference.file.path);
      const markdown =
        cachedMarkdown?.mtime === reference.mtime
          ? cachedMarkdown.markdown
          : await raceWithAbort(
              this.app.vault.cachedRead(reference.file),
              this.signal,
              "Local knowledge reading was cancelled.",
            );
      if (cachedMarkdown?.mtime !== reference.mtime) {
        this.markdownCache.set(reference.file.path, {
          mtime: reference.mtime,
          markdown,
        });
      }
      // 块级选择 + 引文陷阱相对降权：逐字引用了查询原文的块（把问句当例句，
      // 如 A15）基础分极高（词汇+n-gram 双满分），固定折扣压不住；改为相对降权——
      // 有非引用块得分时，引用块上限压到最佳非引用块的一半；全是引用块则保留
      // （合法引用正例：元信息块声明"本文未覆盖 X"时就该被选出）。
      const scoredPassages = splitMarkdownPassages(markdown).map((item) => ({
        ...item,
        score: scorePassage(item, reference.query),
        quotesQuery: containsAnyQueryQuote(
          [reference.query, this.userQuestion],
          `${item.heading} ${item.content}`.toLowerCase(),
        ),
      }));
      const bestNonQuoting = Math.max(
        0,
        ...scoredPassages.filter((item) => !item.quotesQuery).map((item) => item.score),
      );
      const passage = scoredPassages
        .map((item) => ({
          ...item,
          score:
            item.quotesQuery && bestNonQuoting > 0
              ? Math.min(item.score, bestNonQuoting * 0.5)
              : item.score,
        }))
        .sort((left, right) => right.score - left.score)[0];
      if (!passage || passage.score <= 0) {
        continue;
      }
      const remaining = MAX_TOTAL_READ_CHARACTERS - this.totalReadCharacters;
      if (remaining <= 0) {
        break;
      }
      const content = passage.content.slice(0, remaining);
      this.totalReadCharacters += content.length;
      const link = passage.heading
        ? `[[${reference.file.path}#${passage.heading}|${reference.file.basename} › ${passage.heading}]]`
        : `[[${reference.file.path}|${reference.file.basename}]]`;
      this.usedSources.set(reference.file.path, {
        path: reference.file.path,
        title: reference.file.basename,
        heading: passage.heading || "",
        identity: reference.identity,
        epistemicStatus: reference.epistemicStatus,
      });
      const block = [
        `Source: ${link}`,
        `Identity: ${reference.identity}`,
        `Epistemic status: ${reference.epistemicStatus}`,
        content,
      ].join("\n");
      const evidenceKey = [
        reference.file.path,
        reference.mtime,
        passage.heading,
        contentFingerprint(content),
      ].join(":");
      this.passageCache.set(sourceRef, { block, evidenceKey });
      if (!this.emittedEvidenceKeys.has(evidenceKey)) {
        this.emittedEvidenceKeys.add(evidenceKey);
        blocks.push(block);
        this.emittedEvidenceTexts.push(block);
      }
    }
    return blocks.length
      ? blocks.join("\n\n---\n\n")
      : "The requested local passages were already supplied earlier in this run, or the shared local evidence character budget has been reached. Reuse the existing evidence.";
  }

  // 本轮真实发给模型的全部证据块原文（faithfulness 引文核对用）
  getEvidenceTexts(): string[] {
    return [...this.emittedEvidenceTexts];
  }

  getUsedSources() {
    return [...this.usedSources.values()];
  }

  async buildInitialContext(query: string) {
    const results = await this.search(query);
    if (!results.length) {
      return "";
    }
    const evidence = await this.read(results.slice(0, 2).map((item) => item.sourceRef));
    if (!evidence) {
      return "";
    }
    return [
      `Knowledge scope: ${this.scopePath}`,
      "The following passages were retrieved just now from the user's authorized Obsidian folder, specifically for the current question. They are the local evidence for this turn: use them, and cite them with the supplied Obsidian links exactly as given — keep the exact heading text and do not rename or paraphrase headings. If they do not cover the question, say plainly that the notes do not cover it instead of inventing sources. The notes may be personal or imported material; do not assume ownership or mastery unless the text explicitly says so.",
      "",
      evidence,
    ].join("\n");
  }

  // 证据清单（P1 引用对账用）：本轮真实读过的每个文件 + 该文件的全部标题，
  // 供 citation sanitizer 校验/修复答案里的 [[..#..]] 引用。
  getEvidenceInventory(): Array<{
    path: string;
    title: string;
    heading: string;
    headings: string[];
  }> {
    return [...this.usedSources.values()].map((source) => {
      const file = this.app.vault.getAbstractFileByPath(source.path);
      const cache =
        file && (file as any).extension === "md"
          ? this.app.metadataCache.getFileCache(file as TFile)
          : null;
      const headings = ((cache?.headings || []) as Array<{ heading?: string }>)
        .map((item) => String(item.heading || "").trim())
        .filter(Boolean);
      return {
        path: source.path,
        title: source.title,
        heading: source.heading || "",
        headings,
      };
    });
  }

  createTools(): AgentRuntimeTool[] {
    return [
      {
        definition: {
          type: "function",
          function: {
            name: "RetrieveKnowledgeEvidence",
            description:
              "Retrieve directly relevant passages from the already-authorized Obsidian folder (the article being read and sibling notes). Use it whenever the question depends on document content beyond the selected passage — including follow-up questions that change topic or need evidence not yet shown. Prefer one well-formed, self-contained query (resolve pronouns against the conversation); a second, different query is allowed when the evidence is clearly insufficient. Search and passage reading are completed together.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
        },
        execute: async (arguments_) => {
          const query = String(arguments_.query || "").trim();
          if (!query) {
            throw new Error("Local knowledge retrieval requires a query.");
          }
          const results = await this.search(query, MAX_READ_REFS);
          const evidence = results.length
            ? await this.read(results.map((result) => result.sourceRef))
            : "";
          return {
            content:
              evidence ||
              "No directly relevant passages were found in the authorized knowledge scope. Continue from the selected source and clearly disclose this gap.",
            artifacts: {
              localSources: this.getUsedSources(),
              candidateCount: results.length,
            },
          };
        },
      },
    ];
  }
}

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

function queryTerms(value: string) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase();
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
  for (const line of String(markdown || "").split(/\r?\n/)) {
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
  return passages;
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
  return score;
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
  private signal?: AbortSignal;
  private nextSourceRef = 1;
  private sourceRefs = new Map<string, SourceReference>();
  private sourceRefByKey = new Map<string, string>();
  private searchCache = new Map<string, KnowledgeScopeSearchResult[]>();
  private markdownCache = new Map<string, { mtime: number; markdown: string }>();
  private passageCache = new Map<string, { block: string; evidenceKey: string }>();
  private emittedEvidenceKeys = new Set<string>();
  private totalReadCharacters = 0;
  private usedSources = new Map<
    string,
    {
      path: string;
      title: string;
      identity: KnowledgeIdentity;
      epistemicStatus: EpistemicStatus;
    }
  >();

  constructor(options: {
    app: App;
    scopePath: string;
    currentFilePath?: string;
    signal?: AbortSignal;
  }) {
    this.app = options.app;
    this.scopePath = normalizedPath(options.scopePath);
    this.currentFilePath = normalizedPath(options.currentFilePath || "");
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
        const identity = classifyKnowledgeIdentity(file, cache);
        return {
          file,
          cache,
          score: scored.score + bodyScore,
          reasons: bodyScore > 0 ? [...scored.reasons, "body"] : scored.reasons,
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
      const passage = splitMarkdownPassages(markdown)
        .map((item) => ({ ...item, score: scorePassage(item, reference.query) }))
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
      }
    }
    return blocks.length
      ? blocks.join("\n\n---\n\n")
      : "The requested local passages were already supplied earlier in this run, or the shared local evidence character budget has been reached. Reuse the existing evidence.";
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
      "The following passages were retrieved from the user's selected Obsidian scope. They may be personal notes or imported material; do not assume ownership or mastery unless the text explicitly says so. Cite them with the supplied Obsidian links.",
      "",
      evidence,
    ].join("\n");
  }

  createTools(): AgentRuntimeTool[] {
    return [
      {
        definition: {
          type: "function",
          function: {
            name: "SearchKnowledgeScope",
            description:
              "Search note titles, headings, aliases, tags, and links inside the already-authorized Obsidian knowledge scope. Use only when the supplied passages are insufficient.",
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
            throw new Error("Local knowledge search requires a query.");
          }
          const results = await this.search(query);
          return {
            content: results.length
              ? results
                  .map((result, index) =>
                    [
                      `${index + 1}. ${result.title}`,
                      `Source ref: ${result.sourceRef}`,
                      `Path: ${result.path}`,
                      result.headings.length
                        ? `Headings: ${result.headings.join("; ")}`
                        : "",
                      result.tags.length ? `Tags: ${result.tags.join("; ")}` : "",
                      `Identity: ${result.identity}`,
                      `Epistemic status: ${result.epistemicStatus}`,
                      `Matched by: ${result.reasons.join(", ")}`,
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  )
                  .join("\n\n")
              : "No matching notes were found in the authorized knowledge scope.",
            artifacts: { localSources: results },
          };
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "ReadKnowledgePassages",
            description:
              "Read a few exact passages using source refs returned by SearchKnowledgeScope. Arbitrary paths are not accepted.",
            parameters: {
              type: "object",
              properties: {
                source_refs: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: MAX_READ_REFS,
                },
              },
              required: ["source_refs"],
              additionalProperties: false,
            },
          },
        },
        execute: async (arguments_) => {
          const refs = Array.isArray(arguments_.source_refs)
            ? arguments_.source_refs.map((ref) => String(ref))
            : [];
          if (!refs.length || refs.length > MAX_READ_REFS) {
            throw new Error(`ReadKnowledgePassages accepts 1-${MAX_READ_REFS} source refs.`);
          }
          const content = await this.read(refs);
          return {
            content: content || "No matching passages were found in those notes.",
          };
        },
      },
    ];
  }
}

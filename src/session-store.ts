export type QuestionStatus = "pending" | "asked" | "resolved" | "parked";

export interface QuestionRecord {
  id: string;
  sessionId: string;
  text: string;
  status: QuestionStatus;
  sourceExcerpt: string;
  createdAt: number;
  askedAt?: number;
  resolvedAt?: number;
}

export interface HistoricalQuestionMatch extends QuestionRecord {
  sourceFile: string;
  score: number;
}

export interface SessionStorageAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove?(path: string): Promise<void>;
}

export interface SessionStoreOptions {
  adapter: SessionStorageAdapter;
  path: string;
  maxSessions?: number;
  maxBytes?: number;
  maxAgeMs?: number;
}

interface StoredSessionEnvelope {
  version: 1;
  updatedAt: number;
  sessions: any[];
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function plainValue(value: any, seen = new WeakSet<object>()): any {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "undefined" || typeof value === "function") {
    return undefined;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => plainValue(item, seen))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  const result: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "el",
        "bodyEl",
        "file",
        "imageUrl",
        "dataUrl",
        "base64",
        "isRequesting",
      ].includes(key)
    ) {
      continue;
    }
    const normalized = plainValue(child, seen);
    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }
  seen.delete(value);
  return result;
}

function sessionTimestamp(session: any) {
  return Number(session?.updatedAt || session?.createdAt || 0);
}

export function buildQuestionRecords(session: any): QuestionRecord[] {
  const sessionId = String(session?.id || "");
  const pending = Array.isArray(session?.pendingQuestions)
    ? session.pendingQuestions
    : [];
  const records = pending
    .map((question: any, index: number) => {
      const status: QuestionStatus = ["pending", "asked", "resolved", "parked"].includes(
        question?.status,
      )
        ? question.status
        : "pending";
      const record: QuestionRecord = {
        id: String(question?.id || `${sessionId}-question-${index + 1}`),
        sessionId,
        text: String(question?.text || "").trim(),
        status,
        sourceExcerpt: String(question?.source || question?.sourceExcerpt || "").trim(),
        createdAt: Number(question?.createdAt || session?.createdAt || Date.now()),
      };
      if (Number.isFinite(question?.askedAt)) {
        record.askedAt = Number(question.askedAt);
      }
      if (Number.isFinite(question?.resolvedAt)) {
        record.resolvedAt = Number(question.resolvedAt);
      }
      return record;
    })
    .filter((record: QuestionRecord) => record.text);
  const linkedPendingIds = new Set(
    (Array.isArray(session?.messages) ? session.messages : [])
      .map((message: any) => message?.pendingQuestionId)
      .filter((id: unknown) => id !== null && id !== undefined)
      .map(String),
  );
  const linkedTexts = new Set(
    records
      .filter((record) => linkedPendingIds.has(String(record.id)))
      .map((record) => record.text),
  );
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    if (
      message?.role !== "user" ||
      message?.cancelled === true ||
      !String(message?.content || "").trim()
    ) {
      continue;
    }
    const text = String(message.content).trim();
    if (linkedTexts.has(text)) {
      continue;
    }
    records.push({
      id: `${sessionId}-message-${String(message.id || records.length + 1)}`,
      sessionId,
      text,
      status: "asked",
      sourceExcerpt: "",
      createdAt: Number(message.createdAt || session?.createdAt || Date.now()),
      askedAt: Number(message.createdAt || session?.createdAt || Date.now()),
    });
  }
  return records;
}

function normalizedTerms(value: string) {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  const terms = new Set<string>(
    normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [],
  );
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        terms.add(sequence.slice(index, index + size));
      }
    }
  }
  return [...terms].slice(0, 60);
}

function withinScope(path: string, scopePath: string) {
  const file = String(path || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const scope = String(scopePath || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return Boolean(scope && (file === scope || file.startsWith(`${scope}/`)));
}

export function searchHistoricalQuestions(
  sessions: any[],
  query: string,
  options: {
    scopePath: string;
    excludeSessionId?: string | number;
    limit?: number;
  },
): HistoricalQuestionMatch[] {
  const terms = normalizedTerms(query);
  if (!terms.length || !options.scopePath) {
    return [];
  }
  const matches: HistoricalQuestionMatch[] = [];
  for (const session of sessions || []) {
    if (String(session?.id) === String(options.excludeSessionId ?? "")) {
      continue;
    }
    const sourceFile = String(session?.context?.sourceFile || "");
    if (!withinScope(sourceFile, options.scopePath)) {
      continue;
    }
    const records = Array.isArray(session?.questionRecords)
      ? session.questionRecords
      : buildQuestionRecords(session);
    for (const record of records) {
      const haystack = `${record.text}\n${record.sourceExcerpt}`.normalize("NFKC").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += term.length >= 4 ? 3 : 1;
        }
      }
      if (score > 0) {
        matches.push({ ...record, sourceFile, score });
      }
    }
  }
  return matches
    .sort(
      (left, right) =>
        right.score - left.score || right.createdAt - left.createdAt,
    )
    .slice(0, Math.max(1, Math.min(5, options.limit || 3)));
}

export class BoundedSessionStore {
  private adapter: SessionStorageAdapter;
  private path: string;
  private maxSessions: number;
  private maxBytes: number;
  private maxAgeMs: number;

  constructor(options: SessionStoreOptions) {
    this.adapter = options.adapter;
    this.path = options.path;
    this.maxSessions = Math.max(1, options.maxSessions || DEFAULT_MAX_SESSIONS);
    this.maxBytes = Math.max(16_384, options.maxBytes || DEFAULT_MAX_BYTES);
    this.maxAgeMs = Math.max(60_000, options.maxAgeMs || DEFAULT_MAX_AGE_MS);
  }

  async load(): Promise<any[]> {
    if (!(await this.adapter.exists(this.path))) {
      return [];
    }
    try {
      const parsed = JSON.parse(await this.adapter.read(this.path)) as StoredSessionEnvelope;
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
        return [];
      }
      const cutoff = Date.now() - this.maxAgeMs;
      return parsed.sessions
        .filter((session) => sessionTimestamp(session) >= cutoff)
        .slice(0, this.maxSessions)
        .map((session) => ({ ...session, isRequesting: false }));
    } catch {
      return [];
    }
  }

  async save(sessions: any[]): Promise<any[]> {
    const cutoff = Date.now() - this.maxAgeMs;
    const candidates = (sessions || [])
      .map((session) => {
        const normalized = plainValue(session) || {};
        normalized.updatedAt = Number(session?.updatedAt || Date.now());
        normalized.isRequesting = false;
        normalized.questionRecords = buildQuestionRecords(normalized);
        return normalized;
      })
      .filter((session) => sessionTimestamp(session) >= cutoff)
      .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left))
      .slice(0, this.maxSessions);

    const kept = [...candidates];
    let serialized = "";
    while (kept.length) {
      serialized = JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        sessions: kept,
      } satisfies StoredSessionEnvelope);
      if (byteLength(serialized) <= this.maxBytes) {
        break;
      }
      kept.pop();
    }
    if (!kept.length) {
      serialized = JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        sessions: [],
      } satisfies StoredSessionEnvelope);
    }
    await this.adapter.write(this.path, serialized);
    return kept;
  }

  async clear() {
    if (this.adapter.remove) {
      await this.adapter.remove(this.path);
      return;
    }
    await this.save([]);
  }
}

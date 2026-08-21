import {
  selectConversationAncestors,
  type ConversationMessage,
  type ConversationSession,
  type QuestionRecord,
  type QuestionStatus,
} from "./conversation-domain";
import type { QuestionContextItem } from "./external-prompt";

export type { QuestionRecord, QuestionStatus } from "./conversation-domain";

/**
 * Storage still accepts the pre-domain session shape. Known domain fields are
 * typed while unrecognized legacy/UI fields are preserved during save/load.
 */
export type LegacyCompatibleConversationSession =
  Partial<ConversationSession> & Record<string, unknown>;

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

export type SessionSaveDegradationReason =
  | "rebuildable_fields_removed"
  | "messages_shortened"
  | "source_excerpt_shortened"
  | "older_sessions_removed"
  | "essential_data_exceeds_limit";

export interface SessionSaveDegradation {
  status: "ok" | "degraded";
  updatedAt: number;
  maxBytes: number;
  storedBytes: number;
  protectedSessionId: string | null;
  compactedSessionIds: string[];
  droppedSessionIds: string[];
  shortenedMessages: number;
  removedRebuildableFields: number;
  reasons: SessionSaveDegradationReason[];
  exceedsLimit: boolean;
}

export interface SessionSaveResult {
  sessions: LegacyCompatibleConversationSession[];
  report: SessionSaveDegradation;
}

export interface SessionSaveOptions {
  activeSessionId?: string | number | null;
}

interface StoredSessionEnvelope {
  version: 1;
  updatedAt: number;
  sessions: LegacyCompatibleConversationSession[];
  degradation?: SessionSaveDegradation;
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asLegacySession(value: unknown): LegacyCompatibleConversationSession {
  return isRecord(value) ? value : {};
}

function textValue(value: unknown) {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? `${value}`
      : "";
}

function plainValue(value: unknown, seen = new WeakSet<object>()): unknown {
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
    return typeof value === "bigint"
      ? value.toString()
      : typeof value === "symbol"
        ? value.description || ""
        : "";
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
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

function sessionTimestamp(session: LegacyCompatibleConversationSession) {
  return Number(session.updatedAt || session.createdAt || 0);
}

function sessionId(session: LegacyCompatibleConversationSession) {
  return String(session.id ?? "");
}

function addReason(
  reasons: Set<SessionSaveDegradationReason>,
  reason: SessionSaveDegradationReason,
) {
  reasons.add(reason);
}

function shortenText(value: unknown, maxCharacters: number, label: string) {
  const text = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? `${value}`
      : "";
  if (text.length <= maxCharacters) {
    return text;
  }
  return `${text.slice(0, maxCharacters).trimEnd()}\n\n[${label}]`;
}

function normalizeSources(sources: unknown) {
  if (!Array.isArray(sources)) {
    return [];
  }
  return sources.map((source) => {
    if (!source || typeof source !== "object") {
      return source;
    }
    const compact: Record<string, unknown> = {};
    for (const key of [
      "title",
      "url",
      "siteName",
      "site",
      "publishedDate",
      "date",
    ]) {
      if ((source as Record<string, unknown>)[key] !== undefined) {
        compact[key] = (source as Record<string, unknown>)[key];
      }
    }
    return compact;
  });
}

const MESSAGE_RELATIONSHIP_KEYS = new Set([
  "id",
  "role",
  "content",
  "createdAt",
  "cancelled",
  "pendingQuestionId",
  "parentAssistantMessageId",
  "parentQuestionMessageId",
  "sourceExcerpt",
  "sources",
  "storageCompaction",
]);

function compactMessage(message: ConversationMessage, maxContentCharacters: number) {
  const mutable = message as unknown as Record<string, unknown>;
  let removedFields = 0;
  for (const key of Object.keys(mutable)) {
    if (!MESSAGE_RELATIONSHIP_KEYS.has(key)) {
      delete mutable[key];
      removedFields += 1;
    }
  }
  if (Array.isArray(mutable.sources)) {
    mutable.sources = normalizeSources(mutable.sources);
  }
  const originalContent = textValue(mutable.content);
  const previousCompaction = isRecord(mutable.storageCompaction)
    ? mutable.storageCompaction
    : {};
  const originalCharacters = Number(
    previousCompaction.originalCharacters || originalContent.length,
  );
  const shortenedContent = shortenText(
    originalContent,
    maxContentCharacters,
    "Older message shortened to stay within the local conversation storage limit.",
  );
  const shortened = shortenedContent !== originalContent;
  if (shortened) {
    mutable.content = shortenedContent;
  }
  if (removedFields || shortened) {
    mutable.storageCompaction = {
      shortened,
      originalCharacters,
    };
  }
  return {
    changed: Boolean(removedFields || shortened),
    shortened,
    removedFields,
  };
}

function activePathMessageIds(session: LegacyCompatibleConversationSession) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return new Set(
    selectConversationAncestors(messages, session.activePathMessageId)
      .map((message) => String(message.id)),
  );
}

function messageCompactionOrder(
  session: LegacyCompatibleConversationSession,
  protectedSession: boolean,
) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const activePath = protectedSession ? activePathMessageIds(session) : new Set<string>();
  return [...messages].sort((left, right) => {
    const leftProtected = activePath.has(String(left?.id));
    const rightProtected = activePath.has(String(right?.id));
    if (leftProtected !== rightProtected) {
      return leftProtected ? 1 : -1;
    }
    const leftCurrent = String(left?.id) === String(session?.activePathMessageId ?? "");
    const rightCurrent = String(right?.id) === String(session?.activePathMessageId ?? "");
    if (leftCurrent !== rightCurrent) {
      return leftCurrent ? 1 : -1;
    }
    return Number(left?.createdAt || 0) - Number(right?.createdAt || 0);
  });
}

function emptyReport(
  updatedAt: number,
  maxBytes: number,
  protectedSessionId: string | null,
): SessionSaveDegradation {
  return {
    status: "ok",
    updatedAt,
    maxBytes,
    storedBytes: 0,
    protectedSessionId,
    compactedSessionIds: [],
    droppedSessionIds: [],
    shortenedMessages: 0,
    removedRebuildableFields: 0,
    reasons: [],
    exceedsLimit: false,
  };
}

export function buildQuestionRecords(
  session: LegacyCompatibleConversationSession,
): QuestionRecord[] {
  const sessionId = String(session?.id || "");
  const pending: unknown[] = Array.isArray(session?.pendingQuestions)
    ? session.pendingQuestions
    : [];
  const records = pending
    .map((value: unknown, index: number) => {
      if (!isRecord(value)) {
        return null;
      }
      const question = value;
      const status: QuestionStatus =
        question.status === "asked" ||
          question.status === "resolved" ||
          question.status === "parked"
          ? question.status
          : "pending";
      const record: QuestionRecord = {
        id:
          typeof question.id === "string" || typeof question.id === "number"
            ? String(question.id)
            : `${sessionId}-question-${index + 1}`,
        sessionId,
        text: textValue(question.text).trim(),
        status,
        sourceExcerpt: textValue(
          question.source || question.sourceExcerpt,
        ).trim(),
        createdAt: Number(question?.createdAt || session?.createdAt || Date.now()),
      };
      if (question?.isDraft === true) {
        record.isDraft = true;
      }
      if (Array.isArray(question?.contextItems)) {
        record.contextItems = question.contextItems
          .filter(isRecord)
          .filter(
            (item) =>
              typeof item.id === "string" &&
              typeof item.text === "string" &&
              (item.kind === "source_excerpt" ||
                item.kind === "assistant_excerpt" ||
                item.kind === "confirmed_knowledge") &&
              (item.relation === "origin" ||
                item.relation === "support" ||
                item.relation === "contrast"),
          ) as unknown as QuestionContextItem[];
      }
      if (Number.isFinite(Number(question?.sourceStart))) {
        record.sourceStart = Number(question.sourceStart);
      }
      if (Number.isFinite(Number(question?.sourceEnd))) {
        record.sourceEnd = Number(question.sourceEnd);
      }
      if (Number.isFinite(Number(question?.askedAt))) {
        record.askedAt = Number(question.askedAt);
      }
      if (Number.isFinite(Number(question?.resolvedAt))) {
        record.resolvedAt = Number(question.resolvedAt);
      }
      for (const key of [
        "sourceMessageId",
        "questionMessageId",
        "answerMessageId",
        "parentQuestionMessageId",
      ] as const) {
        const value = question?.[key];
        if (typeof value === "string" || typeof value === "number") {
          record[key] = value;
        }
      }
      return record;
    })
    .filter((record): record is QuestionRecord => Boolean(record?.text));
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
  sessions: LegacyCompatibleConversationSession[],
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

  async load(): Promise<LegacyCompatibleConversationSession[]> {
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

  async save(
    sessions: LegacyCompatibleConversationSession[],
    options: SessionSaveOptions = {},
  ): Promise<SessionSaveResult> {
    const updatedAt = Date.now();
    const cutoff = Date.now() - this.maxAgeMs;
    const normalizedSessions = (sessions || [])
      .map((session) => {
        const normalized = asLegacySession(plainValue(session));
        normalized.updatedAt = Number(session?.updatedAt || updatedAt);
        normalized.isRequesting = false;
        // Question records are a derived search index. Older stores may include
        // them, but they can always be rebuilt from pending questions and user
        // messages after loading, so do not duplicate them in persisted data.
        delete normalized.questionRecords;
        return normalized;
      })
      .filter(
        (session) =>
          sessionTimestamp(session) >= cutoff ||
          sessionId(session) === String(options.activeSessionId ?? ""),
      )
      .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left));
    const requestedActiveId = String(options.activeSessionId ?? "");
    const newestSession = normalizedSessions[0] || null;
    const protectedSession = normalizedSessions.find(
      (session) => sessionId(session) === requestedActiveId,
    ) || newestSession;
    const protectedSessionId = protectedSession
      ? sessionId(protectedSession)
      : null;
    const orderedSessions = protectedSession
      ? [
          protectedSession,
          ...normalizedSessions.filter((session) => session !== protectedSession),
        ]
      : normalizedSessions;
    const candidates = orderedSessions.slice(0, this.maxSessions);
    const report = emptyReport(updatedAt, this.maxBytes, protectedSessionId);
    const reasons = new Set<SessionSaveDegradationReason>();
    const compactedSessionIds = new Set<string>();
    const kept = [...candidates];
    const reserveBytes = Math.min(2_048, Math.floor(this.maxBytes * 0.1));
    const payloadBudget = Math.max(1_024, this.maxBytes - reserveBytes);
    const serialize = (includeReport = false) =>
      JSON.stringify({
        version: 1,
        updatedAt,
        sessions: kept,
        ...(includeReport && report.status === "degraded"
          ? { degradation: report }
          : {}),
      } satisfies StoredSessionEnvelope);
    const fitsPayloadBudget = () => byteLength(serialize()) <= payloadBudget;

    if (!fitsPayloadBudget()) {
      const sessionsForCompaction = [...kept].sort((left, right) => {
        const leftProtected = sessionId(left) === protectedSessionId;
        const rightProtected = sessionId(right) === protectedSessionId;
        if (leftProtected !== rightProtected) {
          return leftProtected ? 1 : -1;
        }
        return sessionTimestamp(left) - sessionTimestamp(right);
      });
      for (const session of sessionsForCompaction) {
        for (const message of messageCompactionOrder(
          session,
          sessionId(session) === protectedSessionId,
        )) {
          const result = compactMessage(message, 1_600);
          if (result.changed) {
            compactedSessionIds.add(sessionId(session));
            report.removedRebuildableFields += result.removedFields;
            if (result.removedFields) {
              addReason(reasons, "rebuildable_fields_removed");
            }
            if (result.shortened) {
              report.shortenedMessages += 1;
              addReason(reasons, "messages_shortened");
            }
          }
          if (fitsPayloadBudget()) {
            break;
          }
        }
        if (fitsPayloadBudget()) {
          break;
        }
      }
    }

    if (!fitsPayloadBudget()) {
      const sourceCompactionOrder = [...kept].sort((left, right) => {
        const leftProtected = sessionId(left) === protectedSessionId;
        const rightProtected = sessionId(right) === protectedSessionId;
        if (leftProtected !== rightProtected) {
          return leftProtected ? 1 : -1;
        }
        return sessionTimestamp(left) - sessionTimestamp(right);
      });
      for (const session of sourceCompactionOrder) {
        const excerpt = String(session?.context?.excerpt || "");
        const shortened = shortenText(
          excerpt,
          sessionId(session) === protectedSessionId ? 4_000 : 1_000,
          "Source passage shortened to stay within the local conversation storage limit.",
        );
        if (shortened !== excerpt) {
          session.context = session.context || { sourceFile: "", excerpt: "" };
          session.context.excerpt = shortened;
          const existingCompaction = isRecord(session.storageCompaction)
            ? session.storageCompaction
            : {};
          session.storageCompaction = {
            ...existingCompaction,
            sourceExcerptShortened: true,
            sourceExcerptOriginalCharacters: excerpt.length,
          };
          compactedSessionIds.add(sessionId(session));
          addReason(reasons, "source_excerpt_shortened");
        }
        if (fitsPayloadBudget()) {
          break;
        }
      }
    }

    while (!fitsPayloadBudget()) {
      let oldestIndex = -1;
      let oldestTimestamp = Number.POSITIVE_INFINITY;
      for (let index = 0; index < kept.length; index += 1) {
        if (sessionId(kept[index]) === protectedSessionId) {
          continue;
        }
        const timestamp = sessionTimestamp(kept[index]);
        if (timestamp < oldestTimestamp) {
          oldestIndex = index;
          oldestTimestamp = timestamp;
        }
      }
      if (oldestIndex < 0) {
        break;
      }
      const [dropped] = kept.splice(oldestIndex, 1);
      report.droppedSessionIds.push(sessionId(dropped));
      addReason(reasons, "older_sessions_removed");
    }

    if (!fitsPayloadBudget() && protectedSession) {
      for (const message of messageCompactionOrder(protectedSession, true)) {
        const result = compactMessage(message, 400);
        if (result.changed) {
          compactedSessionIds.add(sessionId(protectedSession));
          report.removedRebuildableFields += result.removedFields;
          if (result.removedFields) {
            addReason(reasons, "rebuildable_fields_removed");
          }
          if (result.shortened) {
            report.shortenedMessages += 1;
            addReason(reasons, "messages_shortened");
          }
        }
        if (fitsPayloadBudget()) {
          break;
        }
      }
    }

    report.compactedSessionIds = [...compactedSessionIds];
    report.reasons = [...reasons];
    report.status = report.reasons.length ? "degraded" : "ok";
    let serialized = serialize(report.status === "degraded");
    for (let index = 0; index < 3; index += 1) {
      report.storedBytes = byteLength(serialized);
      serialized = serialize(report.status === "degraded");
    }
    report.storedBytes = byteLength(serialized);
    report.exceedsLimit = report.storedBytes > this.maxBytes;
    if (report.exceedsLimit) {
      addReason(reasons, "essential_data_exceeds_limit");
      report.status = "degraded";
      report.reasons = [...reasons];
      serialized = serialize(true);
      report.storedBytes = byteLength(serialized);
      serialized = serialize(true);
      report.storedBytes = byteLength(serialized);
    }
    await this.adapter.write(this.path, serialized);
    return { sessions: kept, report };
  }

  async clear() {
    if (this.adapter.remove) {
      await this.adapter.remove(this.path);
      return;
    }
    await this.save([]);
  }
}

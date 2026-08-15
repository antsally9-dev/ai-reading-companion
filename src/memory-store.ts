import type { SessionStorageAdapter } from "./session-store";

export type LearningMemoryStatus =
  | "candidate"
  | "ready_for_review"
  | "confirmed"
  | "rejected"
  | "stale";

export interface LearningMemoryEvidence {
  sessionId: string;
  sourceFile: string;
  excerpt: string;
  createdAt: number;
}

export interface LearningMemoryRecord {
  id: string;
  kind: "explanation_preference";
  statement: string;
  status: LearningMemoryStatus;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
  lastUsedAt?: number;
  evidence: LearningMemoryEvidence[];
}

interface MemoryEnvelope {
  version: 1;
  updatedAt: number;
  records: LearningMemoryRecord[];
}

const MAX_RECORDS = 50;
const MAX_EVIDENCE_PER_RECORD = 8;
const CANDIDATE_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const CONFIRMED_REVIEW_MS = 180 * 24 * 60 * 60 * 1000;

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function terms(value: string) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ");
  const result = new Set<string>(
    normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [],
  );
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      result.add(sequence.slice(index, index + 2));
    }
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = terms(left);
  const b = terms(right);
  if (!a.size || !b.size) {
    return 0;
  }
  let overlap = 0;
  for (const value of a) {
    if (b.has(value)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(a.size, b.size);
}

export function detectLearningPreferenceSignal(message: string) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (text.length < 8 || text.length > 800) {
    return "";
  }
  const explicitChinese =
    /(?:我(?:更容易|喜欢|偏好|习惯|不喜欢)|对我来说|以后请|请尽量|最好(?:用|按)|不要(?:用|只)|记住[:：]).{0,80}(?:解释|讲解|例子|案例|类比|流程|步骤|图|表格|可视化|简洁|详细|先.*后|自己的话)/i;
  const explicitEnglish =
    /(?:i (?:prefer|learn better|understand better|like|dislike)|please (?:explain|use|avoid)|remember:).{0,100}(?:example|analogy|steps|flow|diagram|visual|concise|detail|explain)/i;
  return explicitChinese.test(text) || explicitEnglish.test(text)
    ? text.slice(0, 500)
    : "";
}

export class LearningMemoryStore {
  private adapter: SessionStorageAdapter;
  private path: string;

  constructor(options: { adapter: SessionStorageAdapter; path: string }) {
    this.adapter = options.adapter;
    this.path = options.path;
  }

  async load(): Promise<LearningMemoryRecord[]> {
    if (!(await this.adapter.exists(this.path))) {
      return [];
    }
    try {
      const parsed = JSON.parse(await this.adapter.read(this.path)) as MemoryEnvelope;
      if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
        return [];
      }
      const now = Date.now();
      return parsed.records.slice(0, MAX_RECORDS).map((record) => {
        if (
          (record.status === "candidate" || record.status === "ready_for_review") &&
          now - record.updatedAt > CANDIDATE_STALE_MS
        ) {
          return { ...record, status: "stale" as const };
        }
        if (
          record.status === "confirmed" &&
          now - (record.lastUsedAt || record.confirmedAt || record.updatedAt) >
            CONFIRMED_REVIEW_MS
        ) {
          return { ...record, status: "stale" as const };
        }
        return record;
      });
    } catch {
      return [];
    }
  }

  async save(records: LearningMemoryRecord[]) {
    const bounded = [...records]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RECORDS)
      .map((record) => ({
        ...record,
        statement: String(record.statement || "").slice(0, 500),
        evidence: (record.evidence || []).slice(-MAX_EVIDENCE_PER_RECORD),
      }));
    await this.adapter.write(
      this.path,
      JSON.stringify({ version: 1, updatedAt: Date.now(), records: bounded } satisfies MemoryEnvelope),
    );
    return bounded;
  }

  async observe(
    message: string,
    context: { sessionId: string | number; sourceFile?: string },
  ) {
    const statement = detectLearningPreferenceSignal(message);
    if (!statement) {
      return null;
    }
    const records = await this.load();
    const rejected = records.find(
      (candidate) =>
        candidate.kind === "explanation_preference" &&
        candidate.status === "rejected" &&
        similarity(candidate.statement, statement) >= 0.58,
    );
    if (rejected) {
      return rejected;
    }
    let record = records.find(
      (candidate) =>
        candidate.kind === "explanation_preference" &&
        candidate.status !== "rejected" &&
        similarity(candidate.statement, statement) >= 0.58,
    );
    const now = Date.now();
    const evidence: LearningMemoryEvidence = {
      sessionId: String(context.sessionId || "unknown"),
      sourceFile: String(context.sourceFile || ""),
      excerpt: statement,
      createdAt: now,
    };
    if (!record) {
      record = {
        id: createId(),
        kind: "explanation_preference",
        statement,
        status: "candidate",
        createdAt: now,
        updatedAt: now,
        evidence: [evidence],
      };
      records.push(record);
    } else if (
      !record.evidence.some((item) => item.sessionId === evidence.sessionId)
    ) {
      record.evidence.push(evidence);
      record.updatedAt = now;
    }
    const distinctSessions = new Set(record.evidence.map((item) => item.sessionId)).size;
    if (record.status === "candidate" && distinctSessions >= 3) {
      record.status = "ready_for_review";
    }
    await this.save(records);
    return record;
  }

  async setStatus(id: string, status: LearningMemoryStatus) {
    const records = await this.load();
    const record = records.find((item) => item.id === id);
    if (!record) {
      return null;
    }
    record.status = status;
    record.updatedAt = Date.now();
    if (status === "confirmed") {
      record.confirmedAt = Date.now();
      record.lastUsedAt = Date.now();
    }
    await this.save(records);
    return record;
  }

  async remove(id: string) {
    const records = (await this.load()).filter((item) => item.id !== id);
    await this.save(records);
  }

  async clear() {
    if (this.adapter.remove) {
      await this.adapter.remove(this.path);
      return;
    }
    await this.save([]);
  }

  async getConfirmedPrompt() {
    const records = await this.load();
    const confirmed = records.filter((record) => record.status === "confirmed").slice(0, 8);
    if (!confirmed.length) {
      return "";
    }
    const now = Date.now();
    for (const record of confirmed) {
      record.lastUsedAt = now;
    }
    await this.save(records);
    return confirmed.map((record) => `- ${record.statement}`).join("\n");
  }
}

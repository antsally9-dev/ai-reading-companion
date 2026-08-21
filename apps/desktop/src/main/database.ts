import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseMarkdown } from "../../../../packages/document-core/src/index";
import type {
  AnswerRecord,
  BootstrapSnapshot,
  CreateQuestionInput,
  DocumentDetail,
  DocumentSummary,
  ExcerptRecord,
  ProjectSummary,
  QuestionRecord,
  SaveAnswerInput,
  SaveExcerptInput,
  SearchResult,
  WorkspaceSnapshot,
} from "../shared/contracts";

export interface MarkdownImportFile {
  path: string;
  content: string;
}

interface Row {
  [key: string]: unknown;
}

export class AlphaDatabase {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  bootstrap(): BootstrapSnapshot {
    return {
      projects: this.listProjects(),
      lastProjectId: this.getState("last_project_id") || undefined,
    };
  }

  importDocuments(input: {
    projectId?: string;
    projectName: string;
    rootPath: string;
    files: MarkdownImportFile[];
  }): WorkspaceSnapshot {
    const now = new Date().toISOString();
    const projectId = input.projectId || randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!input.projectId) {
        this.database.prepare(
          "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(projectId, input.projectName, input.rootPath, now, now);
      } else if (!this.projectExists(projectId)) {
        throw new Error("Project not found.");
      }

      for (const file of input.files) {
        this.upsertDocument(projectId, file, now);
      }
      this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
      this.setState("last_project_id", projectId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkspace(projectId);
  }

  listProjects(): ProjectSummary[] {
    const rows = this.database.prepare(`
      SELECT p.id, p.name, p.root_path, p.updated_at, COUNT(d.id) AS document_count
      FROM projects p LEFT JOIN documents d ON d.project_id = p.id
      GROUP BY p.id ORDER BY p.updated_at DESC
    `).all() as Row[];
    return rows.map(toProject);
  }

  getWorkspace(projectId: string): WorkspaceSnapshot {
    const project = this.listProjects().find((item) => item.id === projectId);
    if (!project) throw new Error("Project not found.");
    this.setState("last_project_id", projectId);
    return {
      project,
      documents: this.listDocuments(projectId),
      questions: this.queryQuestions(projectId),
      answers: this.queryAnswers(projectId),
      excerpts: this.queryExcerpts(projectId),
    };
  }

  getDocument(documentId: string): DocumentDetail {
    const row = this.database.prepare(`
      SELECT d.id, d.project_id, d.path, d.title, d.raw_markdown, d.imported_at,
             COUNT(b.id) AS block_count
      FROM documents d LEFT JOIN blocks b ON b.document_id = d.id
      WHERE d.id = ? GROUP BY d.id
    `).get(documentId) as Row | undefined;
    if (!row) throw new Error("Document not found.");
    const blocks = this.database.prepare(`
      SELECT id, ordinal, type, heading_level, content, source_start_line,
             source_end_line, language, image_source, image_alt
      FROM blocks WHERE document_id = ? ORDER BY ordinal
    `).all(documentId) as Row[];
    return {
      ...toDocument(row),
      rawMarkdown: stringValue(row.raw_markdown),
      blocks: blocks.map((block) => ({
        id: stringValue(block.id),
        ordinal: numberValue(block.ordinal),
        type: stringValue(block.type) as DocumentDetail["blocks"][number]["type"],
        content: stringValue(block.content),
        startLine: numberValue(block.source_start_line),
        endLine: numberValue(block.source_end_line),
        headingLevel: nullableNumber(block.heading_level),
        language: nullableString(block.language),
        imageSource: nullableString(block.image_source),
        imageAlt: nullableString(block.image_alt),
      })),
    };
  }

  search(projectId: string, rawQuery: string, limit = 50): SearchResult[] {
    const query = limitText(rawQuery, 200, "Search query").trim();
    if (!query) return [];
    const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.database.prepare(`
      SELECT b.document_id, b.id AS block_id, d.title AS document_title, b.type,
             b.content, b.source_start_line
      FROM blocks b JOIN documents d ON d.id = b.document_id
      WHERE d.project_id = ? AND b.content LIKE ? ESCAPE '\\'
      ORDER BY d.title, b.ordinal LIMIT ?
    `).all(projectId, escaped, Math.max(1, Math.min(limit, 100))) as Row[];
    return rows.map((row) => ({
      documentId: stringValue(row.document_id),
      blockId: stringValue(row.block_id),
      documentTitle: stringValue(row.document_title),
      blockType: stringValue(row.type) as SearchResult["blockType"],
      snippet: createSnippet(stringValue(row.content), query),
      startLine: numberValue(row.source_start_line),
    }));
  }

  createQuestion(input: CreateQuestionInput): QuestionRecord {
    const prompt = limitText(input.prompt, 20_000, "Question").trim();
    const sourceQuote = limitText(input.quote, 100_000, "Source quote").trim();
    if (!prompt) throw new Error("Question cannot be empty.");
    const document = this.database.prepare("SELECT project_id FROM documents WHERE id = ?").get(input.documentId) as Row | undefined;
    if (!document || stringValue(document.project_id) !== input.projectId) throw new Error("Question source is outside this project.");
    if (input.parentQuestionId) {
      const parent = this.database.prepare("SELECT project_id FROM questions WHERE id = ?").get(input.parentQuestionId) as Row | undefined;
      if (!parent || stringValue(parent.project_id) !== input.projectId) throw new Error("Parent question is outside this project.");
    }
    const createdAt = new Date().toISOString();
    const record: QuestionRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      documentId: input.documentId,
      parentQuestionId: input.parentQuestionId,
      sourceBlockId: input.blockId,
      sourceQuote,
      prompt,
      status: "pending",
      createdAt,
    };
    this.database.prepare(`
      INSERT INTO questions
        (id, project_id, document_id, parent_question_id, source_block_id, source_quote, prompt, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.projectId, record.documentId, record.parentQuestionId ?? null,
      record.sourceBlockId ?? null, record.sourceQuote, record.prompt, record.status, record.createdAt,
    );
    return record;
  }

  saveAnswer(input: SaveAnswerInput): AnswerRecord {
    const content = limitText(input.content, 2_000_000, "Answer").trim();
    if (!content) throw new Error("Answer cannot be empty.");
    const existing = this.database.prepare("SELECT id, created_at FROM answers WHERE question_id = ?").get(input.questionId) as Row | undefined;
    const now = new Date().toISOString();
    const record: AnswerRecord = {
      id: existing ? stringValue(existing.id) : randomUUID(),
      questionId: input.questionId,
      content,
      provider: limitText(input.provider ?? "manual", 80, "Provider").trim() || "manual",
      createdAt: existing ? stringValue(existing.created_at) : now,
      updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO answers (id, question_id, content, provider, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(question_id) DO UPDATE SET content = excluded.content,
        provider = excluded.provider, updated_at = excluded.updated_at
    `).run(record.id, record.questionId, record.content, record.provider, record.createdAt, record.updatedAt);
    this.database.prepare("UPDATE questions SET status = 'answered' WHERE id = ?").run(input.questionId);
    return record;
  }

  saveExcerpt(input: SaveExcerptInput): ExcerptRecord {
    const content = limitText(input.content, 1_000_000, "Excerpt").trim();
    if (!content) throw new Error("Excerpt cannot be empty.");
    const now = new Date().toISOString();
    const record: ExcerptRecord = {
      id: randomUUID(),
      questionId: input.questionId,
      documentId: input.documentId,
      sourceBlockId: input.blockId,
      sourceQuote: limitText(input.quote, 100_000, "Source quote").trim(),
      content,
      note: limitText(input.note, 100_000, "Excerpt note").trim(),
      createdAt: now,
      updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO excerpts
        (id, question_id, document_id, source_block_id, source_quote, content, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.questionId ?? null, record.documentId, record.sourceBlockId ?? null,
      record.sourceQuote, record.content, record.note, record.createdAt, record.updatedAt,
    );
    return record;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL, title TEXT NOT NULL, content_hash TEXT NOT NULL,
        raw_markdown TEXT NOT NULL, imported_at TEXT NOT NULL,
        UNIQUE(project_id, path)
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, type TEXT NOT NULL, heading_level INTEGER,
        content TEXT NOT NULL, source_start_line INTEGER NOT NULL, source_end_line INTEGER NOT NULL,
        language TEXT, image_source TEXT, image_alt TEXT,
        UNIQUE(document_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_document ON blocks(document_id, ordinal);
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        parent_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
        source_block_id TEXT, source_quote TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_questions_project ON questions(project_id, created_at);
      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY, question_id TEXT NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
        content TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS excerpts (
        id TEXT PRIMARY KEY, question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        source_block_id TEXT, source_quote TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private upsertDocument(projectId: string, file: MarkdownImportFile, now: string): void {
    const fallbackTitle = file.path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "Untitled";
    const parsed = parseMarkdown(file.content, fallbackTitle);
    const existing = this.database.prepare(
      "SELECT id FROM documents WHERE project_id = ? AND path = ?",
    ).get(projectId, file.path) as Row | undefined;
    const documentId = existing ? stringValue(existing.id) : randomUUID();
    const digest = createHash("sha256").update(file.content).digest("hex");
    this.database.prepare(`
      INSERT INTO documents (id, project_id, path, title, content_hash, raw_markdown, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET title = excluded.title,
        content_hash = excluded.content_hash, raw_markdown = excluded.raw_markdown,
        imported_at = excluded.imported_at
    `).run(documentId, projectId, file.path, parsed.title, digest, file.content, now);
    this.database.prepare("DELETE FROM blocks WHERE document_id = ?").run(documentId);
    const insert = this.database.prepare(`
      INSERT INTO blocks
        (id, document_id, ordinal, type, heading_level, content, source_start_line,
         source_end_line, language, image_source, image_alt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const block of parsed.blocks) {
      insert.run(
        `${documentId}:${block.id}`, documentId, block.ordinal, block.type,
        block.headingLevel ?? null, block.content, block.startLine, block.endLine,
        block.language ?? null, block.imageSource ?? null, block.imageAlt ?? null,
      );
    }
  }

  private listDocuments(projectId: string): DocumentSummary[] {
    return (this.database.prepare(`
      SELECT d.id, d.project_id, d.path, d.title, d.imported_at, COUNT(b.id) AS block_count
      FROM documents d LEFT JOIN blocks b ON b.document_id = d.id
      WHERE d.project_id = ? GROUP BY d.id ORDER BY d.title COLLATE NOCASE
    `).all(projectId) as Row[]).map(toDocument);
  }

  private queryQuestions(projectId: string): QuestionRecord[] {
    return (this.database.prepare("SELECT * FROM questions WHERE project_id = ? ORDER BY created_at").all(projectId) as Row[])
      .map((row) => ({
        id: stringValue(row.id), projectId: stringValue(row.project_id), documentId: stringValue(row.document_id),
        parentQuestionId: nullableString(row.parent_question_id), sourceBlockId: nullableString(row.source_block_id),
        sourceQuote: stringValue(row.source_quote), prompt: stringValue(row.prompt),
        status: stringValue(row.status) as QuestionRecord["status"], createdAt: stringValue(row.created_at),
      }));
  }

  private queryAnswers(projectId: string): AnswerRecord[] {
    return (this.database.prepare(`
      SELECT a.* FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE q.project_id = ? ORDER BY a.created_at
    `).all(projectId) as Row[]).map((row) => ({
      id: stringValue(row.id), questionId: stringValue(row.question_id), content: stringValue(row.content),
      provider: stringValue(row.provider), createdAt: stringValue(row.created_at), updatedAt: stringValue(row.updated_at),
    }));
  }

  private queryExcerpts(projectId: string): ExcerptRecord[] {
    return (this.database.prepare(`
      SELECT e.* FROM excerpts e JOIN documents d ON d.id = e.document_id
      WHERE d.project_id = ? ORDER BY e.created_at
    `).all(projectId) as Row[]).map((row) => ({
      id: stringValue(row.id), questionId: nullableString(row.question_id), documentId: stringValue(row.document_id),
      sourceBlockId: nullableString(row.source_block_id), sourceQuote: stringValue(row.source_quote),
      content: stringValue(row.content), note: stringValue(row.note),
      createdAt: stringValue(row.created_at), updatedAt: stringValue(row.updated_at),
    }));
  }

  private projectExists(projectId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId));
  }

  private getState(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as Row | undefined;
    return row ? stringValue(row.value) : null;
  }

  private setState(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

function toProject(row: Row): ProjectSummary {
  return {
    id: stringValue(row.id), name: stringValue(row.name), rootPath: stringValue(row.root_path),
    documentCount: numberValue(row.document_count), updatedAt: stringValue(row.updated_at),
  };
}

function toDocument(row: Row): DocumentSummary {
  return {
    id: stringValue(row.id), projectId: stringValue(row.project_id), path: stringValue(row.path),
    title: stringValue(row.title), blockCount: numberValue(row.block_count), importedAt: stringValue(row.imported_at),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized || undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberValue(value);
}

function createSnippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 52);
  const end = Math.min(compact.length, start + 180);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

function limitText(value: unknown, maxLength: number, label: string): string {
  const normalized = String(value ?? "");
  if (normalized.length > maxLength) throw new Error(`${label} exceeds the Alpha safety limit.`);
  return normalized;
}

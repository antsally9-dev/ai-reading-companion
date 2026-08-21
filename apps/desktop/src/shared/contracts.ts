import type { DocumentBlock, DocumentBlockType } from "../../../../packages/document-core/src/index";

export type ImportMode = "files" | "folder";
export type QuestionStatus = "pending" | "answered" | "resolved" | "parked";

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  documentCount: number;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  projectId: string;
  path: string;
  title: string;
  blockCount: number;
  importedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  rawMarkdown: string;
  blocks: DocumentBlock[];
}

export interface QuestionRecord {
  id: string;
  projectId: string;
  documentId: string;
  parentQuestionId?: string;
  sourceBlockId?: string;
  sourceQuote: string;
  prompt: string;
  status: QuestionStatus;
  createdAt: string;
}

export interface AnswerRecord {
  id: string;
  questionId: string;
  content: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExcerptRecord {
  id: string;
  questionId?: string;
  documentId: string;
  sourceBlockId?: string;
  sourceQuote: string;
  content: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  project: ProjectSummary;
  documents: DocumentSummary[];
  questions: QuestionRecord[];
  answers: AnswerRecord[];
  excerpts: ExcerptRecord[];
}

export interface BootstrapSnapshot {
  projects: ProjectSummary[];
  lastProjectId?: string;
}

export interface SearchResult {
  documentId: string;
  blockId: string;
  documentTitle: string;
  blockType: DocumentBlockType;
  snippet: string;
  startLine: number;
}

export interface SelectionAnchor {
  documentId: string;
  blockId?: string;
  quote: string;
}

export interface CreateQuestionInput extends SelectionAnchor {
  projectId: string;
  parentQuestionId?: string;
  prompt: string;
}

export interface SaveAnswerInput {
  questionId: string;
  content: string;
  provider?: string;
}

export interface SaveExcerptInput extends SelectionAnchor {
  questionId?: string;
  content: string;
  note: string;
}

export interface DesktopApi {
  bootstrap(): Promise<BootstrapSnapshot>;
  importMarkdown(mode: ImportMode, projectId?: string): Promise<WorkspaceSnapshot | null>;
  openProject(projectId: string): Promise<WorkspaceSnapshot>;
  openDocument(documentId: string): Promise<DocumentDetail>;
  search(projectId: string, query: string): Promise<SearchResult[]>;
  createQuestion(input: CreateQuestionInput): Promise<QuestionRecord>;
  saveAnswer(input: SaveAnswerInput): Promise<AnswerRecord>;
  saveExcerpt(input: SaveExcerptInput): Promise<ExcerptRecord>;
}

export const IPC = {
  bootstrap: "arc:bootstrap",
  importMarkdown: "arc:import-markdown",
  openProject: "arc:open-project",
  openDocument: "arc:open-document",
  search: "arc:search",
  createQuestion: "arc:create-question",
  saveAnswer: "arc:save-answer",
  saveExcerpt: "arc:save-excerpt",
} as const;

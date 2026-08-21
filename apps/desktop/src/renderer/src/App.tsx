import { useEffect, useState } from "react";
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  Import,
  MessageSquarePlus,
  Quote,
  Search,
  Send,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DocumentDetail,
  ExcerptRecord,
  ProjectSummary,
  QuestionRecord,
  SearchResult,
  SelectionAnchor,
  WorkspaceSnapshot,
} from "../../shared/contracts";

type LoadState = "idle" | "loading" | "ready" | "error";

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>();
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const [questionDraft, setQuestionDraft] = useState("");
  const [answerDraft, setAnswerDraft] = useState("");
  const [excerptDraft, setExcerptDraft] = useState("");
  const [excerptNote, setExcerptNote] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [notice, setNotice] = useState("正在读取本地工作区…");

  const selectedQuestion = workspace?.questions.find((question) => question.id === selectedQuestionId);
  const selectedAnswer = workspace?.answers.find((answer) => answer.questionId === selectedQuestionId);

  useEffect(() => {
    void window.arc.bootstrap().then(async (snapshot) => {
      setProjects(snapshot.projects);
      const initialId = snapshot.lastProjectId || snapshot.projects[0]?.id;
      if (initialId) await loadProject(initialId);
      else {
        setLoadState("ready");
        setNotice("导入一份 Markdown，建立第一个本地项目。");
      }
    }).catch(showError);
  }, []);

  useEffect(() => {
    setAnswerDraft(selectedAnswer?.content ?? "");
  }, [selectedAnswer?.id, selectedAnswer?.content]);

  async function loadProject(projectId: string) {
    setLoadState("loading");
    try {
      const snapshot = await window.arc.openProject(projectId);
      setWorkspace(snapshot);
      setProjects((current) => replaceProject(current, snapshot.project));
      setSelectedQuestionId(snapshot.questions[0]?.id);
      const first = snapshot.documents[0];
      setDocument(first ? await window.arc.openDocument(first.id) : null);
      setLoadState("ready");
      setNotice(first ? "" : "这个项目还没有 Markdown 文档。");
    } catch (error) {
      showError(error);
    }
  }

  async function importMarkdown(mode: "files" | "folder") {
    setLoadState("loading");
    try {
      const snapshot = await window.arc.importMarkdown(mode, workspace?.project.id);
      if (!snapshot) {
        setLoadState("ready");
        return;
      }
      setWorkspace(snapshot);
      setProjects((current) => replaceProject(current, snapshot.project));
      const first = snapshot.documents[0];
      setDocument(first ? await window.arc.openDocument(first.id) : null);
      setLoadState("ready");
      setNotice("");
    } catch (error) {
      showError(error);
    }
  }

  async function openDocument(documentId: string, blockId?: string) {
    try {
      const next = await window.arc.openDocument(documentId);
      setDocument(next);
      setSelection(null);
      requestAnimationFrame(() => {
        if (blockId) documentElement(blockId)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    } catch (error) {
      showError(error);
    }
  }

  async function runSearch(query = searchQuery) {
    if (!workspace || !query.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      setSearchResults(await window.arc.search(workspace.project.id, query));
    } catch (error) {
      showError(error);
    }
  }

  async function createQuestion() {
    if (!workspace || !document || !questionDraft.trim()) return;
    try {
      const question = await window.arc.createQuestion({
        projectId: workspace.project.id,
        documentId: document.id,
        blockId: selection?.blockId,
        quote: selection?.quote ?? "",
        parentQuestionId: selectedQuestionId,
        prompt: questionDraft,
      });
      setWorkspace({ ...workspace, questions: [...workspace.questions, question] });
      setSelectedQuestionId(question.id);
      setQuestionDraft("");
      setAnswerDraft("");
      setNotice("问题已加入问题树；Alpha 阶段可粘贴网页端或其他模型的回答。");
    } catch (error) {
      showError(error);
    }
  }

  async function saveAnswer() {
    if (!workspace || !selectedQuestionId || !answerDraft.trim()) return;
    try {
      const answer = await window.arc.saveAnswer({ questionId: selectedQuestionId, content: answerDraft });
      const answers = upsertById(workspace.answers, answer);
      const questions = workspace.questions.map((item) => item.id === selectedQuestionId ? { ...item, status: "answered" as const } : item);
      setWorkspace({ ...workspace, answers, questions });
      setNotice("回答已保存在本地项目中。");
    } catch (error) {
      showError(error);
    }
  }

  async function saveExcerpt() {
    if (!workspace || !document || !excerptDraft.trim()) return;
    try {
      const excerpt = await window.arc.saveExcerpt({
        questionId: selectedQuestionId,
        documentId: document.id,
        blockId: selection?.blockId,
        quote: selection?.quote ?? "",
        content: excerptDraft,
        note: excerptNote,
      });
      setWorkspace({ ...workspace, excerpts: [...workspace.excerpts, excerpt] });
      setExcerptDraft("");
      setExcerptNote("");
      setNotice("可编辑摘录已保存；模型回答不会自动成为你的知识。");
    } catch (error) {
      showError(error);
    }
  }

  function captureSelection() {
    if (!document) return;
    const browserSelection = window.getSelection();
    const quote = browserSelection?.toString().trim() ?? "";
    if (!quote || !browserSelection?.rangeCount) return;
    const range = browserSelection.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const block = node?.closest<HTMLElement>("[data-block-id]");
    const anchor = { documentId: document.id, blockId: block?.dataset.blockId, quote };
    setSelection(anchor);
    setExcerptDraft(quote);
  }

  function showError(error: unknown) {
    setLoadState("error");
    setNotice(error instanceof Error ? error.message : "操作失败，请重试。");
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark"><BookOpenText size={19} /></div>
        <div>
          <strong>AI Reading Companion</strong>
          <span>本地文档理解工作台 · Markdown Alpha</span>
        </div>
        <div className={`runtime-status ${loadState}`}><i />{loadState === "loading" ? "处理中" : "本地就绪"}</div>
      </header>

      <main className="workspace-grid">
        <aside className="index-pane" aria-label="项目与文档">
          <section className="pane-section project-switcher">
            <label htmlFor="project-select">本地项目</label>
            <select id="project-select" value={workspace?.project.id ?? ""} onChange={(event) => void loadProject(event.target.value)}>
              <option value="" disabled>选择项目</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <div className="button-row">
              <button onClick={() => void importMarkdown("files")}><FilePlus2 size={15} />导入文件</button>
              <button onClick={() => void importMarkdown("folder")}><FolderOpen size={15} />导入目录</button>
            </div>
          </section>

          <section className="pane-section search-section">
            <label htmlFor="project-search">项目内检索</label>
            <div className="search-control">
              <Search size={16} />
              <input id="project-search" value={searchQuery} placeholder="查找概念或原文…" onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }} />
            </div>
            {searchResults.length > 0 && (
              <div className="search-results">
                {searchResults.map((result) => (
                  <button key={`${result.documentId}:${result.blockId}`} onClick={() => void openDocument(result.documentId, result.blockId)}>
                    <strong>{result.documentTitle}</strong><span>{result.snippet}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="pane-section document-index">
            <div className="section-heading"><span>文档</span><small>{workspace?.documents.length ?? 0}</small></div>
            {workspace?.documents.map((item) => (
              <button className={item.id === document?.id ? "active" : ""} key={item.id} onClick={() => void openDocument(item.id)}>
                <span>{item.title}</span><small>{item.blockCount} 个块</small>
              </button>
            ))}
          </section>
          {notice && <div className="notice" role="status">{notice}</div>}
        </aside>

        <section className="reader-pane" aria-label="文档阅读区">
          {document ? (
            <>
              <div className="reader-heading">
                <span>{workspace?.project.name}</span>
                <h1>{document.title}</h1>
                <small>{document.path} · {document.blockCount} 个内容块</small>
              </div>
              {selection && (
                <div className="selection-toolbar">
                  <Quote size={15} /><span>{truncate(selection.quote, 90)}</span>
                  <button onClick={() => setQuestionDraft((current) => current || "请解释这段内容：")}>基于此处提问</button>
                </div>
              )}
              <article className="document-reader" onMouseUp={captureSelection}>
                {document.blocks.filter((block) => block.type !== "frontmatter").map((block) => (
                  <DocumentBlockView key={block.id} block={block} />
                ))}
              </article>
            </>
          ) : (
            <EmptyState onImport={() => void importMarkdown("files")} />
          )}
        </section>

        <aside className="thinking-pane" aria-label="问题与知识整理">
          <details open className="question-tree-section">
            <summary><span>问题路径</span><small>{workspace?.questions.length ?? 0}</small></summary>
            <QuestionTree
              questions={workspace?.questions ?? []}
              selectedId={selectedQuestionId}
              onSelect={(question) => {
                setSelectedQuestionId(question.id);
                setAnswerDraft(workspace?.answers.find((answer) => answer.questionId === question.id)?.content ?? "");
                void openDocument(question.documentId, question.sourceBlockId);
              }}
            />
          </details>

          <section className="compose-section">
            <div className="section-heading"><span>记下一个问题</span>{selectedQuestion && <small>作为当前问题的子问题</small>}</div>
            {selection && <blockquote>{selection.quote}</blockquote>}
            <textarea value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} placeholder="先把问题放进树里，不必立即调用模型…" />
            <button className="primary" disabled={!document || !questionDraft.trim()} onClick={() => void createQuestion()}><MessageSquarePlus size={16} />加入问题树</button>
          </section>

          {selectedQuestion && (
            <section className="answer-section">
              <div className="section-heading"><span>当前问题</span><small>{selectedQuestion.status}</small></div>
              <p className="question-prompt">{selectedQuestion.prompt}</p>
              <label htmlFor="answer-draft">回答（可从网页端模型粘贴）</label>
              <textarea id="answer-draft" className="answer-editor" value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} placeholder="Alpha 首版先支持导入和人工编辑答案；下一切片接入共享 Agent Runtime。" />
              <button className="primary" disabled={!answerDraft.trim()} onClick={() => void saveAnswer()}><Send size={16} />保存回答</button>
            </section>
          )}

          <details open className="excerpt-section">
            <summary><span>待整理摘录</span><small>{workspace?.excerpts.length ?? 0}</small></summary>
            <textarea value={excerptDraft} onChange={(event) => setExcerptDraft(event.target.value)} placeholder="选中原文后仍可用自己的话修改…" />
            <input value={excerptNote} onChange={(event) => setExcerptNote(event.target.value)} placeholder="你的联想或解释（可选）" />
            <button disabled={!document || !excerptDraft.trim()} onClick={() => void saveExcerpt()}><Import size={15} />确认保存摘录</button>
            <ExcerptList excerpts={workspace?.excerpts ?? []} />
          </details>
        </aside>
      </main>
    </div>
  );
}

function DocumentBlockView({ block }: { block: DocumentDetail["blocks"][number] }) {
  const common = { id: `block-${cssSafe(block.id)}`, "data-block-id": block.id, "data-start-line": block.startLine };
  if (block.type === "heading") {
    const level = Math.max(1, Math.min(block.headingLevel ?? 2, 6));
    return <div {...common} className={`document-block heading level-${level}`}><ReactMarkdown>{`${"#".repeat(level)} ${block.content}`}</ReactMarkdown></div>;
  }
  if (block.type === "code") return <pre {...common} className="document-block code"><code>{block.content}</code></pre>;
  if (block.type === "image") return <figure {...common} className="document-block image-placeholder"><BookOpenText size={20} /><figcaption>{block.imageAlt || block.content}<small>{block.imageSource}</small></figcaption></figure>;
  return <div {...common} className={`document-block ${block.type}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{block.type === "quote" ? block.content.split("\n").map((line) => `> ${line}`).join("\n") : block.content}</ReactMarkdown></div>;
}

function QuestionTree({ questions, selectedId, onSelect }: { questions: QuestionRecord[]; selectedId?: string; onSelect: (question: QuestionRecord) => void }) {
  const roots = questions.filter((question) => !question.parentQuestionId || !questions.some((item) => item.id === question.parentQuestionId));
  if (questions.length === 0) return <p className="empty-copy">从原文选一段，建立第一条问题路径。</p>;
  return <div className="question-tree">{roots.map((question) => <QuestionNode key={question.id} question={question} questions={questions} selectedId={selectedId} onSelect={onSelect} depth={0} />)}</div>;
}

function QuestionNode({ question, questions, selectedId, onSelect, depth }: { question: QuestionRecord; questions: QuestionRecord[]; selectedId?: string; onSelect: (question: QuestionRecord) => void; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const children = questions.filter((item) => item.parentQuestionId === question.id);
  return <div className="question-node" style={{ "--tree-depth": depth } as React.CSSProperties}>
    <div className={question.id === selectedId ? "question-row selected" : "question-row"}>
      <button className="tree-toggle" aria-label={expanded ? "折叠子问题" : "展开子问题"} disabled={children.length === 0} onClick={() => setExpanded(!expanded)}>{children.length > 0 ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <i />}</button>
      <button className="question-label" onClick={() => onSelect(question)}><span>{question.prompt}</span><small>{question.status}</small></button>
    </div>
    {expanded && children.map((child) => <QuestionNode key={child.id} question={child} questions={questions} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />)}
  </div>;
}

function ExcerptList({ excerpts }: { excerpts: ExcerptRecord[] }) {
  if (excerpts.length === 0) return null;
  return <div className="excerpt-list">{excerpts.slice(-5).reverse().map((excerpt) => <article key={excerpt.id}><p>{truncate(excerpt.content, 160)}</p>{excerpt.note && <small>{excerpt.note}</small>}</article>)}</div>;
}

function EmptyState({ onImport }: { onImport: () => void }) {
  return <div className="empty-state"><div><BookOpenText size={24} /></div><h1>从一份 Markdown 开始</h1><p>原文件保持不变。应用会建立块级行号索引，并把问题、答案和摘录保存在本地数据库中。</p><button className="primary" onClick={onImport}><Import size={16} />选择 Markdown</button></div>;
}

function documentElement(blockId: string): HTMLElement | null {
  return document.getElementById(`block-${cssSafe(blockId)}`);
}

function cssSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function replaceProject(projects: ProjectSummary[], project: ProjectSummary): ProjectSummary[] {
  return [project, ...projects.filter((item) => item.id !== project.id)];
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((current) => current.id === item.id)
    ? items.map((current) => current.id === item.id ? item : current)
    : [...items, item];
}

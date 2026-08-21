import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AlphaDatabase } from "../src/main/database";

test("Markdown project persists documents, question paths, answers, excerpts, and search", () => {
  const directory = mkdtempSync(join(tmpdir(), "arc-desktop-"));
  const databasePath = join(directory, "alpha.sqlite3");
  let database: AlphaDatabase | null = null;
  try {
    database = new AlphaDatabase(databasePath);
    const workspace = database.importDocuments({
      projectName: "Agent Notes",
      rootPath: directory,
      files: [{
        path: join(directory, "memory.md"),
        content: "# Memory\n\nAgent memory needs an update policy.\n\n## Retrieval\n\nRetrieve evidence before answering.",
      }],
    });
    assert.equal(workspace.documents.length, 1);
    assert.equal(workspace.documents[0]?.title, "Memory");
    const document = database.getDocument(workspace.documents[0]!.id);
    const paragraph = document.blocks.find((block) => block.content.includes("update policy"));
    assert.ok(paragraph);

    const rootQuestion = database.createQuestion({
      projectId: workspace.project.id,
      documentId: document.id,
      blockId: paragraph.id,
      quote: "update policy",
      prompt: "What makes an update policy safe?",
    });
    const childQuestion = database.createQuestion({
      projectId: workspace.project.id,
      documentId: document.id,
      parentQuestionId: rootQuestion.id,
      blockId: paragraph.id,
      quote: "Agent memory",
      prompt: "How is this different from retrieval?",
    });
    const answer = database.saveAnswer({ questionId: rootQuestion.id, content: "It needs explicit evidence and bounded writes." });
    const excerpt = database.saveExcerpt({
      questionId: rootQuestion.id,
      documentId: document.id,
      blockId: paragraph.id,
      quote: "update policy",
      content: "A memory update should be evidence-backed.",
      note: "My working definition",
    });
    assert.equal(answer.provider, "manual");
    assert.equal(excerpt.questionId, rootQuestion.id);
    assert.equal(database.search(workspace.project.id, "retrieval").length, 1);
    database.close();

    database = new AlphaDatabase(databasePath);
    const restored = database.getWorkspace(workspace.project.id);
    assert.equal(restored.questions.length, 2);
    assert.equal(restored.questions.find((item) => item.id === childQuestion.id)?.parentQuestionId, rootQuestion.id);
    assert.equal(restored.answers[0]?.content, "It needs explicit evidence and bounded writes.");
    assert.equal(restored.excerpts[0]?.note, "My working definition");
    database.close();
    database = null;
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

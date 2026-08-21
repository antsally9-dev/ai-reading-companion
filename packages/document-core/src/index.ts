export type DocumentBlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "code"
  | "table"
  | "image"
  | "frontmatter";

export interface DocumentBlock {
  id: string;
  ordinal: number;
  type: DocumentBlockType;
  content: string;
  startLine: number;
  endLine: number;
  headingLevel?: number;
  language?: string;
  imageSource?: string;
  imageAlt?: string;
}

export interface ParsedMarkdownDocument {
  title: string;
  blocks: DocumentBlock[];
  lineCount: number;
}

const IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'].*["'])?\)\s*$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const LIST_ITEM = /^\s*(?:[-+*]|\d+[.)])\s+/;
const TABLE_DIVIDER = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

export function parseMarkdown(markdown: string, fallbackTitle = "Untitled"): ParsedMarkdownDocument {
  const normalized = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: DocumentBlock[] = [];
  let cursor = 0;

  const push = (block: Omit<DocumentBlock, "id" | "ordinal">) => {
    const ordinal = blocks.length;
    blocks.push({
      ...block,
      id: `b-${ordinal + 1}-${hashText(`${block.type}:${block.startLine}:${block.content}`)}`,
      ordinal,
    });
  };

  if (lines[0]?.trim() === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closing > 0) {
      push({
        type: "frontmatter",
        content: lines.slice(1, closing).join("\n"),
        startLine: 1,
        endLine: closing + 1,
      });
      cursor = closing + 1;
    }
  }

  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (!line.trim()) {
      cursor += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      push({
        type: "heading",
        content: heading[2]?.trim() ?? "",
        headingLevel: heading[1]?.length ?? 1,
        startLine: cursor + 1,
        endLine: cursor + 1,
      });
      cursor += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const start = cursor;
      const language = line.trim().slice(3).trim();
      cursor += 1;
      const body: string[] = [];
      while (cursor < lines.length && !/^\s*```/.test(lines[cursor] ?? "")) {
        body.push(lines[cursor] ?? "");
        cursor += 1;
      }
      if (cursor < lines.length) cursor += 1;
      push({
        type: "code",
        content: body.join("\n"),
        language: language || undefined,
        startLine: start + 1,
        endLine: cursor,
      });
      continue;
    }

    const image = line.trim().match(IMAGE_ONLY);
    if (image) {
      push({
        type: "image",
        content: image[1] || image[2] || "Image",
        imageAlt: image[1] || "",
        imageSource: image[2] || "",
        startLine: cursor + 1,
        endLine: cursor + 1,
      });
      cursor += 1;
      continue;
    }

    if (
      line.includes("|") &&
      cursor + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[cursor + 1] ?? "")
    ) {
      const start = cursor;
      const body = [line, lines[cursor + 1] ?? ""];
      cursor += 2;
      while (cursor < lines.length && (lines[cursor] ?? "").includes("|")) {
        body.push(lines[cursor] ?? "");
        cursor += 1;
      }
      push({
        type: "table",
        content: body.join("\n"),
        startLine: start + 1,
        endLine: cursor,
      });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const start = cursor;
      const body: string[] = [];
      while (cursor < lines.length && (LIST_ITEM.test(lines[cursor] ?? "") || /^\s{2,}\S/.test(lines[cursor] ?? ""))) {
        body.push(lines[cursor] ?? "");
        cursor += 1;
      }
      push({ type: "list", content: body.join("\n"), startLine: start + 1, endLine: cursor });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const start = cursor;
      const body: string[] = [];
      while (cursor < lines.length && /^\s*>/.test(lines[cursor] ?? "")) {
        body.push((lines[cursor] ?? "").replace(/^\s*>\s?/, ""));
        cursor += 1;
      }
      push({ type: "quote", content: body.join("\n"), startLine: start + 1, endLine: cursor });
      continue;
    }

    const start = cursor;
    const body: string[] = [];
    while (cursor < lines.length) {
      const current = lines[cursor] ?? "";
      if (!current.trim()) break;
      if (cursor > start && isBlockBoundary(current, lines[cursor + 1])) break;
      body.push(current);
      cursor += 1;
    }
    push({
      type: "paragraph",
      content: body.join("\n").trim(),
      startLine: start + 1,
      endLine: Math.max(start + 1, cursor),
    });
  }

  const title = blocks.find((block) => block.type === "heading" && block.headingLevel === 1)?.content
    || blocks.find((block) => block.type === "heading")?.content
    || fallbackTitle;
  return { title, blocks, lineCount: lines.length };
}

function isBlockBoundary(line: string, nextLine?: string): boolean {
  return HEADING.test(line)
    || /^\s*```/.test(line)
    || Boolean(line.trim().match(IMAGE_ONLY))
    || LIST_ITEM.test(line)
    || /^\s*>/.test(line)
    || (line.includes("|") && Boolean(nextLine && TABLE_DIVIDER.test(nextLine)));
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

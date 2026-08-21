import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { dialog } from "electron";
import type { MarkdownImportFile } from "./database";
import type { ImportMode } from "../shared/contracts";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface MarkdownSelection {
  projectName: string;
  rootPath: string;
  files: MarkdownImportFile[];
}

export async function chooseMarkdown(mode: ImportMode): Promise<MarkdownSelection | null> {
  if (mode === "folder") {
    const selected = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const root = selected.filePaths[0];
    if (selected.canceled || !root) return null;
    const safeRoot = await realpath(root);
    const paths = await collectMarkdown(safeRoot);
    return {
      projectName: basename(safeRoot),
      rootPath: safeRoot,
      files: await readMarkdownFiles(paths, safeRoot),
    };
  }

  const selected = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (selected.canceled || selected.filePaths.length === 0) return null;
  const rootPath = dirname(selected.filePaths[0] ?? "");
  const paths = selected.filePaths.slice(0, MAX_FILES);
  return {
    projectName: paths.length === 1 ? basename(paths[0] ?? "", extname(paths[0] ?? "")) : basename(rootPath),
    rootPath,
    files: await readMarkdownFiles(paths, rootPath),
  };
}

async function collectMarkdown(rootPath: string): Promise<string[]> {
  const results: string[] = [];
  const pending = [rootPath];
  while (pending.length > 0 && results.length < MAX_FILES) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && isMarkdown(entryPath)) results.push(entryPath);
      if (results.length >= MAX_FILES) break;
    }
  }
  return results;
}

async function readMarkdownFiles(paths: string[], rootPath: string): Promise<MarkdownImportFile[]> {
  const safeRoot = await realpath(rootPath);
  let totalBytes = 0;
  const files: MarkdownImportFile[] = [];
  for (const selectedPath of paths) {
    if (!isMarkdown(selectedPath)) continue;
    const safePath = await realpath(selectedPath);
    const metadata = await lstat(safePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (metadata.size > MAX_FILE_BYTES || totalBytes + metadata.size > MAX_TOTAL_BYTES) {
      throw new Error("The selected Markdown import exceeds the Alpha safety limit.");
    }
    if (relative(safeRoot, safePath).startsWith("..")) {
      throw new Error("A selected file resolves outside the chosen project root.");
    }
    const content = await readFile(safePath, "utf8");
    totalBytes += Buffer.byteLength(content);
    files.push({ path: safePath, content });
  }
  return files;
}

function isMarkdown(filePath: string): boolean {
  return [".md", ".markdown"].includes(extname(filePath).toLocaleLowerCase());
}

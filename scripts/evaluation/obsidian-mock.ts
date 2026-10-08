// Obsidian API 的 Node mock：仅实现 knowledge-scope.ts 用到的 normalizePath。
export function normalizePath(path: string): string {
  return String(path)
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

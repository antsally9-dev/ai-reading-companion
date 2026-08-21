import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { AlphaDatabase } from "./database";
import { chooseMarkdown } from "./import-markdown";
import type {
  CreateQuestionInput,
  ImportMode,
  SaveAnswerInput,
  SaveExcerptInput,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";

let mainWindow: BrowserWindow | null = null;
let database: AlphaDatabase | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#f7f8fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    callback: (...args: TArgs) => TResult | Promise<TResult>,
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: TArgs) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error("Rejected IPC request from an untrusted frame.");
      }
      return callback(...args);
    });
  };
  const store = () => {
    if (!database) throw new Error("Database is not ready.");
    return database;
  };
  handle(IPC.bootstrap, () => store().bootstrap());
  handle(IPC.importMarkdown, async (mode: ImportMode, projectId?: string) => {
    if (mode !== "files" && mode !== "folder") throw new Error("Unsupported import mode.");
    const selection = await chooseMarkdown(mode);
    if (!selection) return null;
    return store().importDocuments({ ...selection, projectId });
  });
  handle(IPC.openProject, (projectId: string) => store().getWorkspace(requireId(projectId)));
  handle(IPC.openDocument, (documentId: string) => store().getDocument(requireId(documentId)));
  handle(IPC.search, (projectId: string, query: string) => store().search(requireId(projectId), String(query ?? "")));
  handle(IPC.createQuestion, (input: CreateQuestionInput) => store().createQuestion(input));
  handle(IPC.saveAnswer, (input: SaveAnswerInput) => store().saveAnswer(input));
  handle(IPC.saveExcerpt, (input: SaveExcerptInput) => store().saveExcerpt(input));
}

app.whenReady().then(() => {
  database = new AlphaDatabase(join(app.getPath("userData"), "reading-companion-alpha.sqlite3"));
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  console.error("Desktop startup failed", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  database?.close();
  database = null;
});

function requireId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 128) throw new Error("Invalid identifier.");
  return normalized;
}

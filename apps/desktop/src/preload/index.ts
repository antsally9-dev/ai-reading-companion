import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateQuestionInput,
  DesktopApi,
  ImportMode,
  SaveAnswerInput,
  SaveExcerptInput,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";

const api: DesktopApi = Object.freeze({
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  importMarkdown: (mode: ImportMode, projectId?: string) =>
    ipcRenderer.invoke(IPC.importMarkdown, mode, projectId),
  openProject: (projectId: string) => ipcRenderer.invoke(IPC.openProject, projectId),
  openDocument: (documentId: string) => ipcRenderer.invoke(IPC.openDocument, documentId),
  search: (projectId: string, query: string) => ipcRenderer.invoke(IPC.search, projectId, query),
  createQuestion: (input: CreateQuestionInput) => ipcRenderer.invoke(IPC.createQuestion, input),
  saveAnswer: (input: SaveAnswerInput) => ipcRenderer.invoke(IPC.saveAnswer, input),
  saveExcerpt: (input: SaveExcerptInput) => ipcRenderer.invoke(IPC.saveExcerpt, input),
});

contextBridge.exposeInMainWorld("arc", api);

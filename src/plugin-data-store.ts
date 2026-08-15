import type { SessionStorageAdapter } from "./session-store";

const LOCAL_DATA_KEY = "localData";
const LOCAL_DATA_VERSION = 1;

interface LocalDataEnvelope {
  version: 1;
  updatedAt: number;
  sections: Record<string, unknown>;
}

type PluginDataDocument = Record<string, unknown>;

function normalizeDocument(value: unknown): PluginDataDocument {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as PluginDataDocument) }
    : {};
}

function normalizeLocalData(value: unknown): LocalDataEnvelope {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Partial<LocalDataEnvelope>;
    if (
      candidate.version === LOCAL_DATA_VERSION &&
      candidate.sections &&
      typeof candidate.sections === "object" &&
      !Array.isArray(candidate.sections)
    ) {
      return {
        version: LOCAL_DATA_VERSION,
        updatedAt: Number(candidate.updatedAt || Date.now()),
        sections: { ...candidate.sections },
      };
    }
  }
  return {
    version: LOCAL_DATA_VERSION,
    updatedAt: Date.now(),
    sections: {},
  };
}

function parseSection(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Coordinates every write to Obsidian's single plugin data.json document.
 * Settings remain at the document root for backwards compatibility, while
 * bounded runtime data lives under `localData.sections`.
 */
export class PluginDataStore {
  private loadData: () => Promise<unknown>;
  private saveData: (data: PluginDataDocument) => Promise<void>;
  private document: PluginDataDocument | null = null;
  private loading: Promise<PluginDataDocument> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    loadData: () => Promise<unknown>;
    saveData: (data: PluginDataDocument) => Promise<void>;
  }) {
    this.loadData = options.loadData;
    this.saveData = options.saveData;
  }

  private async ensureLoaded() {
    if (this.document) {
      return this.document;
    }
    if (this.loading === null) {
      this.loading = this.loadData().then((data) => {
        this.document = normalizeDocument(data);
        return this.document;
      });
    }
    return this.loading;
  }

  private async afterPendingWrites() {
    await this.writeQueue;
    return this.ensureLoaded();
  }

  private enqueueWrite(
    mutate: (document: PluginDataDocument) => PluginDataDocument,
  ) {
    const operation = this.writeQueue.then(async () => {
      const current = await this.ensureLoaded();
      const next = mutate(current);
      await this.saveData(next);
      this.document = next;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async loadSettings() {
    const document = await this.afterPendingWrites();
    const { [LOCAL_DATA_KEY]: _localData, ...settings } = document;
    return settings;
  }

  async saveSettings(settings: Record<string, unknown>) {
    const cleanSettings = { ...settings };
    delete cleanSettings[LOCAL_DATA_KEY];
    await this.enqueueWrite((document) => {
      const localData = normalizeLocalData(document[LOCAL_DATA_KEY]);
      return { ...cleanSettings, [LOCAL_DATA_KEY]: localData };
    });
  }

  createSectionAdapter(): SessionStorageAdapter {
    return {
      exists: async (section) => {
        const document = await this.afterPendingWrites();
        const localData = normalizeLocalData(document[LOCAL_DATA_KEY]);
        return Object.prototype.hasOwnProperty.call(localData.sections, section);
      },
      read: async (section) => {
        const document = await this.afterPendingWrites();
        const localData = normalizeLocalData(document[LOCAL_DATA_KEY]);
        const value = localData.sections[section];
        return typeof value === "string" ? value : JSON.stringify(value);
      },
      write: async (section, value) => {
        await this.enqueueWrite((document) => {
          const localData = normalizeLocalData(document[LOCAL_DATA_KEY]);
          localData.updatedAt = Date.now();
          localData.sections[section] = parseSection(value);
          return { ...document, [LOCAL_DATA_KEY]: localData };
        });
      },
      remove: async (section) => {
        await this.enqueueWrite((document) => {
          const localData = normalizeLocalData(document[LOCAL_DATA_KEY]);
          delete localData.sections[section];
          localData.updatedAt = Date.now();
          return { ...document, [LOCAL_DATA_KEY]: localData };
        });
      },
    };
  }
}

import type { QuestionContextItem } from "./external-prompt";

/**
 * Existing persisted conversations used numeric, string, and generated IDs.
 * The domain keeps accepting both so old local stores can be opened without a
 * destructive rewrite. New callers should use `createStableConversationId`.
 */
export type ConversationEntityId = string | number;

export type ConversationRole = "user" | "assistant";

export interface DocumentSourceAnchor {
  kind: "document";
  sourceFile: string;
  exactQuote: string;
  sourceHeading?: string;
  lineRange?: string;
  startBlockId?: string;
  endBlockId?: string;
  startOffset?: number | null;
  endOffset?: number | null;
  documentVersion?: string;
  contentHash?: string;
}

export interface MessageSourceAnchor {
  kind: "message";
  messageId: ConversationEntityId;
  exactQuote: string;
  startOffset?: number | null;
  endOffset?: number | null;
}

/** A durable pointer to either imported source material or a conversation answer. */
export type SourceAnchor = DocumentSourceAnchor | MessageSourceAnchor;

interface ConversationMessageBase {
  id: ConversationEntityId;
  role: ConversationRole;
  content: string;
  createdAt?: number;
  cancelled?: boolean;
  sourceAnchor?: SourceAnchor;
}

export interface UserConversationMessage extends ConversationMessageBase {
  role: "user";
  parentAssistantMessageId?: ConversationEntityId | null;
  pendingQuestionId?: ConversationEntityId | null;
  sourceExcerpt?: string;
  contextItems?: QuestionContextItem[];
}

export interface AssistantConversationMessage extends ConversationMessageBase {
  role: "assistant";
  parentQuestionMessageId?: ConversationEntityId | null;
  sources?: ConversationSourceReference[];
}

export type ConversationMessage =
  | UserConversationMessage
  | AssistantConversationMessage;

export interface ConversationSourceReference {
  title?: string;
  url?: string;
  siteName?: string;
  site?: string;
  publishedDate?: string;
  date?: string;
}

export type QuestionStatus = "pending" | "asked" | "resolved" | "parked";

export interface QuestionRecord {
  id: ConversationEntityId;
  sessionId: string;
  text: string;
  status: QuestionStatus;
  sourceExcerpt: string;
  createdAt: number;
  updatedAt?: number;
  askedAt?: number;
  resolvedAt?: number;
  sourceMessageId?: ConversationEntityId | null;
  questionMessageId?: ConversationEntityId | null;
  answerMessageId?: ConversationEntityId | null;
  parentQuestionMessageId?: ConversationEntityId | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  sourceAnchor?: SourceAnchor;
  isDraft?: boolean;
  contextItems?: QuestionContextItem[];
}

export interface ExcerptRecord {
  id: ConversationEntityId;
  text: string;
  createdAt: number;
  sourceMessageId?: ConversationEntityId | null;
  sourceQuestionMessageId?: ConversationEntityId | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  sourceAnchor?: SourceAnchor;
  linkedQuestionKey?: string;
}

export interface ConversationSourceContext {
  sourceFile: string;
  excerpt: string;
  sourceHeading?: string;
  lineRange?: string;
}

/**
 * Platform-independent persisted state. Transient Obsidian DOM references and
 * view preferences deliberately do not belong to this type.
 */
export interface ConversationSession {
  id: ConversationEntityId;
  context: ConversationSourceContext;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  pendingQuestions: QuestionRecord[];
  excerptRecords: ExcerptRecord[];
  excerptDraft: string;
  activePathMessageId: ConversationEntityId | null;
}

export type ConversationValidationIssueCode =
  | "missing_session_id"
  | "missing_message_id"
  | "duplicate_message_id"
  | "invalid_message_role"
  | "dangling_parent"
  | "parent_role_mismatch"
  | "relationship_cycle"
  | "invalid_active_endpoint"
  | "inferred_parent_relationship";

export interface ConversationValidationIssue {
  code: ConversationValidationIssueCode;
  message: string;
  entityId?: ConversationEntityId;
}

export interface ConversationMigrationResult {
  session: ConversationSession;
  issues: ConversationValidationIssue[];
  migrated: boolean;
  valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown) {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
}

function asFiniteNumber(value: unknown, fallback: number) {
  const numeric = optionalFiniteNumber(value);
  return numeric === null ? fallback : numeric;
}

function optionalId(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : null;
}

function optionalFiniteNumber(value: unknown) {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && value.trim())
  ) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function migrateSourceAnchor(value: unknown): SourceAnchor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const exactQuote = asText(value.exactQuote);
  if (value.kind === "document" && asText(value.sourceFile)) {
    return {
      kind: "document",
      sourceFile: asText(value.sourceFile),
      exactQuote,
      ...(asText(value.sourceHeading)
        ? { sourceHeading: asText(value.sourceHeading) }
        : {}),
      ...(asText(value.lineRange) ? { lineRange: asText(value.lineRange) } : {}),
      ...(asText(value.startBlockId)
        ? { startBlockId: asText(value.startBlockId) }
        : {}),
      ...(asText(value.endBlockId)
        ? { endBlockId: asText(value.endBlockId) }
        : {}),
      ...(optionalFiniteNumber(value.startOffset) !== null
        ? { startOffset: optionalFiniteNumber(value.startOffset) }
        : {}),
      ...(optionalFiniteNumber(value.endOffset) !== null
        ? { endOffset: optionalFiniteNumber(value.endOffset) }
        : {}),
      ...(asText(value.documentVersion)
        ? { documentVersion: asText(value.documentVersion) }
        : {}),
      ...(asText(value.contentHash)
        ? { contentHash: asText(value.contentHash) }
        : {}),
    };
  }
  const messageId = optionalId(value.messageId);
  if (value.kind === "message" && messageId !== null) {
    return {
      kind: "message",
      messageId,
      exactQuote,
      ...(optionalFiniteNumber(value.startOffset) !== null
        ? { startOffset: optionalFiniteNumber(value.startOffset) }
        : {}),
      ...(optionalFiniteNumber(value.endOffset) !== null
        ? { endOffset: optionalFiniteNumber(value.endOffset) }
        : {}),
    };
  }
  return undefined;
}

function migrateContextItems(value: unknown) {
  const items: QuestionContextItem[] = [];
  for (const rawValue of Array.isArray(value) ? value : []) {
    if (
      !isRecord(rawValue) ||
      !asText(rawValue.text).trim() ||
      !["source_excerpt", "assistant_excerpt", "confirmed_knowledge"].includes(
        asText(rawValue.kind),
      )
    ) {
      continue;
    }
    const kind = rawValue.kind as QuestionContextItem["kind"];
    const relation = ["origin", "support", "contrast"].includes(
      asText(rawValue.relation),
    )
      ? rawValue.relation as QuestionContextItem["relation"]
      : "support";
    const item: QuestionContextItem = {
      id: asText(rawValue.id) || `context-${items.length + 1}`,
      kind,
      relation,
      text: asText(rawValue.text).trim(),
    };
    for (const key of ["sourceFile", "sourceHeading", "lineRange"] as const) {
      const text = asText(rawValue[key]);
      if (text) {
        item[key] = text;
      }
    }
    const messageId = optionalId(rawValue.messageId);
    if (messageId !== null) {
      item.messageId = messageId;
    }
    const questionMessageId = optionalId(rawValue.questionMessageId);
    if (questionMessageId !== null) {
      item.questionMessageId = questionMessageId;
    }
    const itemCreatedAt = optionalFiniteNumber(rawValue.createdAt);
    if (itemCreatedAt !== null) {
      item.createdAt = itemCreatedAt;
    }
    items.push(item);
  }
  return items;
}

export function conversationIdKey(value: unknown) {
  const id = optionalId(value);
  return id === null ? "" : String(id);
}

function encodeStableIdPart(value: ConversationEntityId) {
  const normalized = String(value).normalize("NFKC").trim();
  if (!normalized) {
    throw new Error("Stable conversation IDs require non-empty parts.");
  }
  return encodeURIComponent(normalized);
}

/**
 * Creates a deterministic, collision-resistant-within-scope identifier while
 * keeping the source components inspectable for migrations and diagnostics.
 */
export function createStableConversationId(
  kind: "session" | "message" | "question" | "excerpt",
  scopeId: ConversationEntityId,
  localId: ConversationEntityId,
) {
  return `arc:${kind}:${encodeStableIdPart(scopeId)}:${encodeStableIdPart(localId)}`;
}

function parentIdFor(message: ConversationMessage) {
  return message.role === "user"
    ? message.parentAssistantMessageId
    : message.parentQuestionMessageId;
}

function expectedParentRole(message: ConversationMessage): ConversationRole {
  return message.role === "user" ? "assistant" : "user";
}

/**
 * Immutable graph projection over append-only conversation messages. It never
 * repairs or mutates input data; migrations are handled separately below.
 */
export class ConversationGraph {
  readonly messages: readonly ConversationMessage[];
  readonly messagesById: ReadonlyMap<string, ConversationMessage>;
  readonly childrenById: ReadonlyMap<string, readonly ConversationMessage[]>;
  readonly activeEndpointMessageId: ConversationEntityId | null;
  readonly issues: readonly ConversationValidationIssue[];

  constructor(
    messages: readonly ConversationMessage[],
    preferredEndpointMessageId?: ConversationEntityId | null,
  ) {
    this.messages = [...messages];
    const byId = new Map<string, ConversationMessage>();
    const issues: ConversationValidationIssue[] = [];
    for (const message of this.messages) {
      const key = conversationIdKey(message?.id);
      if (!key) {
        issues.push({
          code: "missing_message_id",
          message: "Conversation message is missing an ID.",
        });
        continue;
      }
      if (byId.has(key)) {
        issues.push({
          code: "duplicate_message_id",
          message: `Conversation message ID is duplicated: ${key}`,
          entityId: message.id,
        });
        continue;
      }
      byId.set(key, message);
    }

    const mutableChildren = new Map<string, ConversationMessage[]>();
    for (const message of byId.values()) {
      const parentId = parentIdFor(message);
      const parentKey = conversationIdKey(parentId);
      if (!parentKey) {
        continue;
      }
      const parent = byId.get(parentKey);
      if (!parent) {
        issues.push({
          code: "dangling_parent",
          message: `Message ${String(message.id)} points to a missing parent ${parentKey}.`,
          entityId: message.id,
        });
        continue;
      }
      if (parent.role !== expectedParentRole(message)) {
        issues.push({
          code: "parent_role_mismatch",
          message: `Message ${String(message.id)} points to a parent with the wrong role.`,
          entityId: message.id,
        });
        continue;
      }
      const children = mutableChildren.get(parentKey) || [];
      children.push(message);
      mutableChildren.set(parentKey, children);
    }

    for (const message of byId.values()) {
      const visited = new Set<string>();
      let current: ConversationMessage | undefined = message;
      while (current) {
        const key = conversationIdKey(current.id);
        if (visited.has(key)) {
          issues.push({
            code: "relationship_cycle",
            message: `Conversation relationship cycle reaches message ${key}.`,
            entityId: message.id,
          });
          break;
        }
        visited.add(key);
        const parentKey = conversationIdKey(parentIdFor(current));
        current = parentKey ? byId.get(parentKey) : undefined;
      }
    }

    this.messagesById = byId;
    this.childrenById = new Map(
      [...mutableChildren].map(([key, children]) => [key, [...children]]),
    );
    const preferredKey = conversationIdKey(preferredEndpointMessageId);
    if (preferredKey && !byId.has(preferredKey)) {
      issues.push({
        code: "invalid_active_endpoint",
        message: `Active endpoint does not exist: ${preferredKey}`,
        entityId: preferredEndpointMessageId ?? undefined,
      });
    }
    this.activeEndpointMessageId = preferredKey && byId.has(preferredKey)
      ? byId.get(preferredKey)?.id ?? null
      : this.resolveLatestEndpoint()?.id ?? null;
    this.issues = dedupeValidationIssues(issues);
  }

  messageById(messageId: ConversationEntityId | null | undefined) {
    const key = conversationIdKey(messageId);
    return key ? this.messagesById.get(key) || null : null;
  }

  childrenOf(messageId: ConversationEntityId) {
    return [...(this.childrenById.get(conversationIdKey(messageId)) || [])];
  }

  parentOf(messageId: ConversationEntityId) {
    const message = this.messageById(messageId);
    return message ? this.messageById(parentIdFor(message)) : null;
  }

  ancestorChain(
    endpointMessageId: ConversationEntityId | null | undefined =
      this.activeEndpointMessageId,
  ) {
    const reversedPath: ConversationMessage[] = [];
    const visited = new Set<string>();
    let current = this.messageById(endpointMessageId);
    while (current) {
      const currentKey = conversationIdKey(current.id);
      if (!currentKey || visited.has(currentKey) || current.cancelled === true) {
        break;
      }
      visited.add(currentKey);
      reversedPath.push(current);
      const parent = this.parentOf(current.id);
      if (!parent || parent.role !== expectedParentRole(current)) {
        break;
      }
      current = parent;
    }
    return reversedPath.reverse();
  }

  questionPath(
    endpointMessageId: ConversationEntityId | null | undefined =
      this.activeEndpointMessageId,
  ) {
    return this.ancestorChain(endpointMessageId).filter(
      (message): message is UserConversationMessage => message.role === "user",
    );
  }

  private resolveLatestEndpoint() {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (
        message &&
        message.cancelled !== true &&
        this.messagesById.get(conversationIdKey(message.id)) === message
      ) {
        return message;
      }
    }
    return null;
  }
}

function dedupeValidationIssues(issues: ConversationValidationIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\u0000${String(issue.entityId ?? "")}\u0000${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function selectConversationAncestors(
  messages: readonly ConversationMessage[],
  endpointMessageId: ConversationEntityId | null | undefined,
) {
  const endpointKey = conversationIdKey(endpointMessageId);
  if (!endpointKey) {
    return [];
  }
  const byId = new Map<string, ConversationMessage>();
  for (const message of messages) {
    const key = conversationIdKey(message?.id);
    if (key && !byId.has(key)) {
      byId.set(key, message);
    }
  }
  const reversedPath: ConversationMessage[] = [];
  const visited = new Set<string>();
  let current = byId.get(endpointKey);
  while (current) {
    const currentKey = conversationIdKey(current.id);
    if (!currentKey || visited.has(currentKey) || current.cancelled === true) {
      break;
    }
    visited.add(currentKey);
    reversedPath.push(current);
    const parentKey = conversationIdKey(parentIdFor(current));
    const parent = parentKey ? byId.get(parentKey) : undefined;
    if (!parent || parent.role !== expectedParentRole(current)) {
      break;
    }
    current = parent;
  }
  return reversedPath.reverse();
}

export function validateConversationSession(session: ConversationSession) {
  const issues: ConversationValidationIssue[] = [];
  if (!conversationIdKey(session.id)) {
    issues.push({
      code: "missing_session_id",
      message: "Conversation session is missing an ID.",
    });
  }
  issues.push(
    ...new ConversationGraph(
      session.messages,
      session.activePathMessageId,
    ).issues,
  );
  return dedupeValidationIssues(issues);
}

function migrateSourceContext(value: unknown): ConversationSourceContext {
  const context = isRecord(value) ? value : {};
  const startLine = optionalFiniteNumber(context.startLine);
  const endLine = optionalFiniteNumber(context.endLine);
  const lineRange = asText(context.lineRange) ||
    (startLine !== null
      ? endLine !== null && endLine !== startLine
        ? `${startLine}-${endLine}`
        : String(startLine)
      : "");
  return {
    sourceFile: asText(context.sourceFile),
    excerpt: asText(context.excerpt),
    ...(asText(context.sourceHeading || context.heading)
      ? { sourceHeading: asText(context.sourceHeading || context.heading) }
      : {}),
    ...(lineRange
      ? { lineRange }
      : {}),
  };
}

function migrateMessages(
  value: unknown,
  sessionId: ConversationEntityId,
  issues: ConversationValidationIssue[],
) {
  const messages: ConversationMessage[] = [];
  const usedIds = new Set<string>();
  let previousAssistantId: ConversationEntityId | null = null;
  let previousQuestionId: ConversationEntityId | null = null;
  for (const [index, rawValue] of (Array.isArray(value) ? value : []).entries()) {
    if (!isRecord(rawValue)) {
      issues.push({
        code: "invalid_message_role",
        message: `Conversation message ${index + 1} is not an object.`,
      });
      continue;
    }
    if (rawValue.role !== "user" && rawValue.role !== "assistant") {
      issues.push({
        code: "invalid_message_role",
        message: `Conversation message ${index + 1} has an unsupported role.`,
      });
      continue;
    }
    let id: ConversationEntityId =
      typeof rawValue.id === "string" || typeof rawValue.id === "number"
        ? rawValue.id
        : createStableConversationId("message", sessionId, index + 1);
    if (!conversationIdKey(rawValue.id)) {
      issues.push({
        code: "missing_message_id",
        message: `Conversation message ${index + 1} received a stable migration ID.`,
        entityId: id,
      });
    }
    if (usedIds.has(conversationIdKey(id))) {
      issues.push({
        code: "duplicate_message_id",
        message: `Conversation message ID is duplicated: ${String(id)}`,
        entityId: id,
      });
      id = createStableConversationId("message", sessionId, `duplicate-${index + 1}`);
    }
    usedIds.add(conversationIdKey(id));
    const common = {
      id,
      content: asText(rawValue.content),
      ...(Number.isFinite(Number(rawValue.createdAt))
        ? { createdAt: Number(rawValue.createdAt) }
        : {}),
      ...(rawValue.cancelled === true ? { cancelled: true } : {}),
    };
    const sourceAnchor = migrateSourceAnchor(rawValue.sourceAnchor);
    if (rawValue.role === "user") {
      const explicitParent = rawValue.parentAssistantMessageId;
      const contextItems = migrateContextItems(rawValue.contextItems);
      if (
        optionalId(explicitParent) === null &&
        previousAssistantId !== null
      ) {
        issues.push({
          code: "inferred_parent_relationship",
          message: `Legacy user message ${String(id)} was linked to the preceding answer.`,
          entityId: id,
        });
      }
      const message: UserConversationMessage = {
        ...common,
        role: "user",
        parentAssistantMessageId:
          typeof explicitParent === "string" || typeof explicitParent === "number"
            ? explicitParent
            : previousAssistantId,
        ...(optionalId(rawValue.pendingQuestionId) !== null
          ? { pendingQuestionId: optionalId(rawValue.pendingQuestionId) }
          : {}),
        ...(asText(rawValue.sourceExcerpt)
          ? { sourceExcerpt: asText(rawValue.sourceExcerpt) }
          : {}),
        ...(contextItems.length
          ? { contextItems }
          : {}),
        ...(sourceAnchor
          ? { sourceAnchor }
          : {}),
      };
      messages.push(message);
      previousQuestionId = id;
    } else {
      const explicitParent = rawValue.parentQuestionMessageId;
      if (optionalId(explicitParent) === null && previousQuestionId !== null) {
        issues.push({
          code: "inferred_parent_relationship",
          message: `Legacy assistant message ${String(id)} was linked to the preceding question.`,
          entityId: id,
        });
      }
      const message: AssistantConversationMessage = {
        ...common,
        role: "assistant",
        parentQuestionMessageId:
          typeof explicitParent === "string" || typeof explicitParent === "number"
            ? explicitParent
            : previousQuestionId,
        ...(sourceAnchor
          ? { sourceAnchor }
          : {}),
        ...(Array.isArray(rawValue.sources)
          ? {
              sources: rawValue.sources
                .filter(isRecord)
                .map((source) => ({
                  ...(asText(source.title) ? { title: asText(source.title) } : {}),
                  ...(asText(source.url) ? { url: asText(source.url) } : {}),
                  ...(asText(source.siteName)
                    ? { siteName: asText(source.siteName) }
                    : {}),
                  ...(asText(source.site) ? { site: asText(source.site) } : {}),
                  ...(asText(source.publishedDate)
                    ? { publishedDate: asText(source.publishedDate) }
                    : {}),
                  ...(asText(source.date) ? { date: asText(source.date) } : {}),
                })),
            }
          : {}),
      };
      messages.push(message);
      previousAssistantId = id;
    }
  }
  return messages;
}

function migrateQuestions(
  value: unknown,
  sessionId: string,
  createdAt: number,
) {
  const questions: QuestionRecord[] = [];
  for (const [index, rawValue] of (Array.isArray(value) ? value : []).entries()) {
    if (!isRecord(rawValue)) {
      continue;
    }
    const id = typeof rawValue.id === "string" || typeof rawValue.id === "number"
      ? rawValue.id
      : createStableConversationId("question", sessionId, index + 1);
    const status: QuestionStatus =
      rawValue.status === "asked" ||
        rawValue.status === "resolved" ||
        rawValue.status === "parked"
        ? rawValue.status
        : "pending";
    const updatedAt = optionalFiniteNumber(rawValue.updatedAt);
    const askedAt = optionalFiniteNumber(rawValue.askedAt);
    const resolvedAt = optionalFiniteNumber(rawValue.resolvedAt);
    const sourceMessageId = optionalId(rawValue.sourceMessageId);
    const questionMessageId = optionalId(rawValue.questionMessageId);
    const answerMessageId = optionalId(rawValue.answerMessageId);
    const parentQuestionMessageId = optionalId(rawValue.parentQuestionMessageId);
    const sourceStart = optionalFiniteNumber(rawValue.sourceStart);
    const sourceEnd = optionalFiniteNumber(rawValue.sourceEnd);
    const sourceExcerpt = asText(
      rawValue.sourceExcerpt || rawValue.source,
    ).trim();
    const explicitAnchor = migrateSourceAnchor(rawValue.sourceAnchor);
    const sourceAnchor = explicitAnchor ||
      (sourceMessageId !== null && sourceExcerpt
        ? {
            kind: "message" as const,
            messageId: sourceMessageId,
            exactQuote: sourceExcerpt,
            ...(sourceStart !== null ? { startOffset: sourceStart } : {}),
            ...(sourceEnd !== null ? { endOffset: sourceEnd } : {}),
          }
        : undefined);
    const contextItems = migrateContextItems(rawValue.contextItems);
    questions.push({
      id,
      sessionId,
      text: asText(rawValue.text).trim(),
      status,
      sourceExcerpt,
      createdAt: asFiniteNumber(rawValue.createdAt, createdAt),
      ...(updatedAt !== null
        ? { updatedAt }
        : {}),
      ...(askedAt !== null
        ? { askedAt }
        : {}),
      ...(resolvedAt !== null
        ? { resolvedAt }
        : {}),
      ...(sourceMessageId !== null
        ? { sourceMessageId }
        : {}),
      ...(questionMessageId !== null
        ? { questionMessageId }
        : {}),
      ...(answerMessageId !== null
        ? { answerMessageId }
        : {}),
      ...(parentQuestionMessageId !== null
        ? { parentQuestionMessageId }
        : {}),
      ...(sourceStart !== null
        ? { sourceStart }
        : {}),
      ...(sourceEnd !== null
        ? { sourceEnd }
        : {}),
      ...(sourceAnchor
        ? { sourceAnchor }
        : {}),
      ...(contextItems.length
        ? { contextItems }
        : {}),
      ...(rawValue.isDraft === true ? { isDraft: true } : {}),
    });
  }
  return questions;
}

function migrateExcerpts(value: unknown, sessionId: string, createdAt: number) {
  const excerpts: ExcerptRecord[] = [];
  for (const [index, rawValue] of (Array.isArray(value) ? value : []).entries()) {
    if (!isRecord(rawValue)) {
      continue;
    }
    const sourceMessageId = optionalId(rawValue.sourceMessageId);
    const sourceQuestionMessageId = optionalId(rawValue.sourceQuestionMessageId);
    const sourceStart = optionalFiniteNumber(rawValue.sourceStart);
    const sourceEnd = optionalFiniteNumber(rawValue.sourceEnd);
    const excerptText = asText(rawValue.text);
    const explicitAnchor = migrateSourceAnchor(rawValue.sourceAnchor);
    const sourceAnchor = explicitAnchor ||
      (sourceMessageId !== null && excerptText
        ? {
            kind: "message" as const,
            messageId: sourceMessageId,
            exactQuote: excerptText,
            ...(sourceStart !== null ? { startOffset: sourceStart } : {}),
            ...(sourceEnd !== null ? { endOffset: sourceEnd } : {}),
          }
        : undefined);
    excerpts.push({
      id:
        typeof rawValue.id === "string" || typeof rawValue.id === "number"
          ? rawValue.id
          : createStableConversationId("excerpt", sessionId, index + 1),
      text: excerptText,
      createdAt: asFiniteNumber(rawValue.createdAt, createdAt),
      ...(sourceMessageId !== null
        ? { sourceMessageId }
        : {}),
      ...(sourceQuestionMessageId !== null
        ? { sourceQuestionMessageId }
        : {}),
      ...(sourceStart !== null
        ? { sourceStart }
        : {}),
      ...(sourceEnd !== null
        ? { sourceEnd }
        : {}),
      ...(sourceAnchor
        ? { sourceAnchor }
        : {}),
      ...(asText(rawValue.linkedQuestionKey)
        ? { linkedQuestionKey: asText(rawValue.linkedQuestionKey) }
        : {}),
    });
  }
  return excerpts;
}

/**
 * Converts the legacy loose JSON shape into the minimal strict domain model.
 * The operation is deterministic, non-mutating, and does not rewrite storage.
 */
export function migrateLegacyConversationSession(
  value: unknown,
  fallbackSessionId: ConversationEntityId = "legacy-session",
): ConversationMigrationResult {
  const raw = isRecord(value) ? value : {};
  const issues: ConversationValidationIssue[] = [];
  const sessionId = conversationIdKey(raw.id)
    ? (raw.id as ConversationEntityId)
    : createStableConversationId("session", "legacy", fallbackSessionId);
  if (!conversationIdKey(raw.id)) {
    issues.push({
      code: "missing_session_id",
      message: "Conversation session received a stable migration ID.",
      entityId: sessionId,
    });
  }
  const createdAt = asFiniteNumber(raw.createdAt, 0);
  const messages = migrateMessages(raw.messages, sessionId, issues);
  const graph = new ConversationGraph(
    messages,
    typeof raw.activePathMessageId === "string" ||
        typeof raw.activePathMessageId === "number"
      ? raw.activePathMessageId
      : null,
  );
  const session: ConversationSession = {
    id: sessionId,
    context: migrateSourceContext(raw.context),
    createdAt,
    updatedAt: asFiniteNumber(raw.updatedAt, createdAt),
    messages,
    pendingQuestions: migrateQuestions(
      raw.pendingQuestions,
      String(sessionId),
      createdAt,
    ),
    excerptRecords: migrateExcerpts(
      raw.excerptRecords,
      String(sessionId),
      createdAt,
    ),
    excerptDraft: asText(raw.excerptDraft),
    activePathMessageId: graph.activeEndpointMessageId,
  };
  issues.push(...graph.issues);
  const normalizedIssues = dedupeValidationIssues(issues);
  const rawContext = isRecord(raw.context) ? raw.context : {};
  const canonicalShapeWasPresent =
    conversationIdKey(raw.id) !== "" &&
    typeof raw.createdAt === "number" &&
    Number.isFinite(raw.createdAt) &&
    typeof raw.updatedAt === "number" &&
    Number.isFinite(raw.updatedAt) &&
    typeof rawContext.sourceFile === "string" &&
    typeof rawContext.excerpt === "string" &&
    Array.isArray(raw.messages) &&
    Array.isArray(raw.pendingQuestions) &&
    Array.isArray(raw.excerptRecords) &&
    typeof raw.excerptDraft === "string" &&
    (raw.activePathMessageId === null ||
      optionalId(raw.activePathMessageId) !== null) &&
    !(typeof rawContext.heading === "string" && !rawContext.sourceHeading);
  const postMigrationIssues = validateConversationSession(session);
  return {
    session,
    issues: normalizedIssues,
    migrated: normalizedIssues.length > 0 || !canonicalShapeWasPresent,
    valid: postMigrationIssues.length === 0,
  };
}

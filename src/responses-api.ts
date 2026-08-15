export type ModelApiProtocol = "chat_completions" | "responses";

export type HostedWebSearchType = "" | "web_search" | "web_search_preview";

export interface ResponsesApiSource {
  title: string;
  url: string;
  snippet: string;
  siteName: string;
  date: string;
}

function stringifyMessageContent(content: any) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content || "");
  }
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : String(part?.text || part?.content || ""),
    )
    .filter(Boolean)
    .join("\n");
}

function toResponsesUserContent(content: any) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content || "");
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return { type: "input_text", text: part };
      }
      if (part?.type === "text" || part?.type === "input_text") {
        return { type: "input_text", text: String(part.text || "") };
      }
      if (part?.type === "image_url" || part?.type === "input_image") {
        const imageUrl =
          typeof part.image_url === "string"
            ? part.image_url
            : part.image_url?.url;
        return imageUrl
          ? { type: "input_image", image_url: String(imageUrl) }
          : null;
      }
      return null;
    })
    .filter(Boolean);
}

export function toResponsesInput(messages: any[]) {
  const instructions: string[] = [];
  const input: any[] = [];
  for (const message of messages || []) {
    if (!message) {
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      const instruction = stringifyMessageContent(message.content).trim();
      if (instruction) {
        instructions.push(instruction);
      }
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id || ""),
        output: stringifyMessageContent(message.content),
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const assistantText = stringifyMessageContent(message.content).trim();
      if (assistantText) {
        input.push({ role: "assistant", content: assistantText });
      }
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: String(toolCall?.id || ""),
          name: String(toolCall?.function?.name || ""),
          arguments:
            typeof toolCall?.function?.arguments === "string"
              ? toolCall.function.arguments
              : JSON.stringify(toolCall?.function?.arguments || {}),
        });
      }
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    input.push({
      role,
      content:
        role === "user"
          ? toResponsesUserContent(message.content)
          : stringifyMessageContent(message.content),
    });
  }
  return {
    instructions: instructions.join("\n\n"),
    input,
  };
}

export function toResponsesFunctionTools(
  toolDefinitions: Record<string, any>[],
) {
  return (toolDefinitions || [])
    .map((definition) => {
      const functionDefinition = definition?.function;
      if (definition?.type !== "function" || !functionDefinition?.name) {
        return null;
      }
      return {
        type: "function",
        name: String(functionDefinition.name),
        description: String(functionDefinition.description || ""),
        parameters: functionDefinition.parameters || {
          type: "object",
          properties: {},
        },
        ...(typeof functionDefinition.strict === "boolean"
          ? { strict: functionDefinition.strict }
          : {}),
      };
    })
    .filter(Boolean);
}

export function buildResponsesRequestBody(options: {
  model: string;
  messages: any[];
  toolDefinitions?: Record<string, any>[];
  hostedWebSearchType?: HostedWebSearchType;
}) {
  const converted = toResponsesInput(options.messages);
  const tools: any[] = toResponsesFunctionTools(
    options.toolDefinitions || [],
  );
  if (options.hostedWebSearchType) {
    tools.push({ type: options.hostedWebSearchType });
  }
  return {
    model: options.model,
    store: false,
    ...(converted.instructions
      ? { instructions: converted.instructions }
      : {}),
    input: converted.input,
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
  };
}

export function makeResponsesUrl(baseUrl: string) {
  const normalized = String(baseUrl || "")
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");
  if (/\/responses$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/responses`;
}

function validHttpUrl(value: unknown) {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(url) ? url : "";
}

function sourceTitle(url: string, preferred = "") {
  if (preferred.trim()) {
    return preferred.trim();
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function sourceFromObject(value: any): ResponsesApiSource | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const citation = value.url_citation || value.citation || value;
  const url = validHttpUrl(citation.url || citation.uri || citation.link);
  if (!url) {
    return null;
  }
  return {
    title: sourceTitle(
      url,
      String(citation.title || citation.name || value.title || ""),
    ),
    url,
    snippet: String(
      citation.snippet || citation.text || value.snippet || value.text || "",
    ).trim(),
    siteName: String(
      citation.site_name || citation.siteName || value.site_name || "",
    ).trim(),
    date: String(
      citation.date || citation.published_date || value.date || "",
    ).trim(),
  };
}

function collectResponseSources(responseBody: any) {
  const sources: ResponsesApiSource[] = [];
  const add = (value: any) => {
    const source = sourceFromObject(value);
    if (source) {
      sources.push(source);
    }
  };
  for (const item of Array.isArray(responseBody?.output)
    ? responseBody.output
    : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      for (const annotation of Array.isArray(part?.annotations)
        ? part.annotations
        : []) {
        add(annotation);
      }
    }
    for (const result of [
      ...(Array.isArray(item?.results) ? item.results : []),
      ...(Array.isArray(item?.sources) ? item.sources : []),
      ...(Array.isArray(item?.action?.results) ? item.action.results : []),
      ...(Array.isArray(item?.action?.sources) ? item.action.sources : []),
    ]) {
      add(result);
    }
  }
  for (const citation of Array.isArray(responseBody?.citations)
    ? responseBody.citations
    : []) {
    add(citation);
  }
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) {
      return false;
    }
    seen.add(source.url);
    return true;
  });
}

export function extractResponsesAssistantMessage(responseBody: any) {
  const outputItems = Array.isArray(responseBody?.output)
    ? responseBody.output
    : [];
  const content = outputItems
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === "output_text" || part?.type === "text")
    .map((part) => String(part.text || ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  const toolCalls = outputItems
    .filter((item) => item?.type === "function_call")
    .map((item) => ({
      id: String(item.call_id || item.id || ""),
      type: "function",
      function: {
        name: String(item.name || ""),
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments || {}),
      },
    }));
  return {
    role: "assistant",
    content:
      content ||
      (typeof responseBody?.output_text === "string"
        ? responseBody.output_text.trim()
        : ""),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    sources: collectResponseSources(responseBody),
    responseId: String(responseBody?.id || ""),
  };
}

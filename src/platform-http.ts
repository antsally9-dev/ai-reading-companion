/**
 * Platform-neutral HTTP boundary used by the Agent and search runtimes.
 *
 * Core modules must depend on this contract instead of importing a host SDK
 * such as Obsidian. A host adapter is responsible for translating the request
 * and normalizing the response.
 */
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  signal?: AbortSignal;
}

export interface HttpResponse<TJson = any> {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: TJson;
  arrayBuffer?: ArrayBuffer;
}

export interface HttpClient {
  request<TJson = any>(request: HttpRequest): Promise<HttpResponse<TJson>>;
}


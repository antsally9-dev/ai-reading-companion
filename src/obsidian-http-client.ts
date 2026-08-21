import { requestUrl } from "obsidian";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from "./platform-http";

/** Obsidian host adapter for the platform-neutral HTTP contract. */
export const obsidianHttpClient: HttpClient = {
  async request<TJson = any>(request: HttpRequest): Promise<HttpResponse<TJson>> {
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      // The shared transports classify HTTP status codes themselves.
      throw: false,
    });
    let json: TJson;
    try {
      json = response.json as TJson;
    } catch {
      // Text and binary endpoints are valid users of the shared boundary.
      // A host must not turn a non-JSON response into a transport failure.
      json = undefined;
    }
    return {
      status: Number(response.status || 0),
      headers: response.headers || {},
      text: String(response.text || ""),
      json,
      arrayBuffer: response.arrayBuffer,
    };
  },
};

import {
  EXTENSION_PROTOCOL,
  EXTENSION_ROUTES,
  type ExtensionInboxKeyResponse,
  type PollConnectResponse,
  type PostClipRequest,
  type PostClipResponse,
  type StartConnectResponse,
} from "knowtarium/clip";

// The five routes the extension calls, and nothing else. Every request carries the protocol
// version; every request that isn't a GET also `Knowtarium-Request: 1`. The extension routes take
// the token as a bearer token; no request sends cookies. An answer is one of three things: a 2xx
// with its JSON, an error status with the protocol's error code when the body has one, or
// `network` when no answer came at all (offline, DNS, a refused CORS check, a timeout).

/** How long one request may take before it counts as a network failure. */
export const REQUEST_TIMEOUT_MS = 20_000;

export type ApiResult<T> =
  | { readonly kind: "ok"; readonly status: number; readonly body: T }
  | { readonly kind: "network" }
  | {
      readonly kind: "error";
      readonly status: number;
      /** The protocol's error code (`error.code`), or null when the body has none. */
      readonly code: string | null;
      /** The whole `error` object of the body, for codes with fields of their own. */
      readonly error: Readonly<Record<string, unknown>> | null;
      /** From `Retry-After` or the body's `retryAfterSeconds`, when given. */
      readonly retryAfterSeconds: number | null;
    };

export interface ExtensionApi {
  startConnect(extensionVersion: string): Promise<ApiResult<StartConnectResponse>>;
  pollConnect(requestId: string, pollSecret: string): Promise<ApiResult<PollConnectResponse>>;
  postClip(token: string, request: PostClipRequest): Promise<ApiResult<PostClipResponse>>;
  getInboxKey(token: string): Promise<ApiResult<ExtensionInboxKeyResponse>>;
  revoke(token: string): Promise<ApiResult<unknown>>;
}

/** The subset of `fetch` the client uses, so tests can answer for the server. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfter(response: Response, error: Record<string, unknown> | null): number | null {
  const header = response.headers.get("Retry-After");
  const fromHeader = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  const fromBody = error?.["retryAfterSeconds"];
  return typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0
    ? fromBody
    : null;
}

export function createApi(origin: string, fetchImpl: FetchLike = fetch): ExtensionApi {
  async function call<T>(
    route: { readonly method: string; readonly path: string },
    options: { path?: string; token?: string; body?: unknown } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      [EXTENSION_PROTOCOL.versionHeader]: String(EXTENSION_PROTOCOL.version),
    };
    if (route.method !== "GET") headers[EXTENSION_PROTOCOL.requestHeader] = "1";
    if (options.token !== undefined) headers["Authorization"] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(origin + (options.path ?? route.path), {
        method: route.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { kind: "network" };
    }
    let body: unknown;
    try {
      const text = await response.text();
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (response.ok) return { kind: "ok", status: response.status, body: body as T };
    const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : null;
    const code = typeof error?.["code"] === "string" ? error["code"] : null;
    return {
      kind: "error",
      status: response.status,
      code,
      error,
      retryAfterSeconds: retryAfter(response, error),
    };
  }

  return {
    startConnect: (extensionVersion) =>
      call(EXTENSION_ROUTES.startConnect, { body: { client: "extension", extensionVersion } }),
    pollConnect: (requestId, pollSecret) =>
      call(EXTENSION_ROUTES.pollConnect, {
        path: EXTENSION_ROUTES.pollConnect.path.replace(
          ":requestId",
          encodeURIComponent(requestId),
        ),
        body: { pollSecret },
      }),
    postClip: (token, request) => call(EXTENSION_ROUTES.postClip, { token, body: request }),
    getInboxKey: (token) => call(EXTENSION_ROUTES.getExtensionInboxKey, { token }),
    revoke: (token) => call(EXTENSION_ROUTES.revokeCurrentExtension, { token }),
  };
}

// A fake sync API at the fetch level, answering the five routes the extension calls the way the
// design says the real one does: connect requests with a poll secret and a one-time relay, and
// clips checked for the token, the size, the inbox key generation, duplicates and limits. Tests
// steer it through its state and `override`, which can answer any request first.

import type { SignedInboxKey } from "knowtarium/clip";

import type { FetchLike } from "../../src/lib/api";

export const ORIGIN = "https://api.test";

interface ConnectRequest {
  status: "pending" | "approved" | "relayed" | "denied" | "expired" | "completed";
  pollSecret: string;
  relay?: string;
}

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type Override = (request: SentRequest) => Response | undefined;

export interface FakeApi {
  readonly fetch: FetchLike;
  readonly requests: SentRequest[];
  readonly connect: Map<string, ConnectRequest>;
  /** Pending clips by ID, with their sealed bytes (base64url). */
  readonly clips: Map<string, string>;
  /** Clip IDs already filed (a repeated post answers `duplicate`). */
  readonly filed: Set<string>;
  readonly tokens: Set<string>;
  readonly revoked: Set<string>;
  inboxKey: SignedInboxKey | null;
  /** Fails every request as if offline. */
  offline: boolean;
  override: Override | null;
  pollIntervalSeconds: number;
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(status, { error: { code, message: code, ...extra } }, headers);
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function requestId(): string {
  let body = "0";
  for (let i = 0; i < 25; i++) body += ID_ALPHABET.charAt(Math.floor(Math.random() * 32));
  return `cr_${body}`;
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

export function fakeApi(): FakeApi {
  const api: FakeApi = {
    requests: [],
    connect: new Map(),
    clips: new Map(),
    filed: new Set(),
    tokens: new Set(),
    revoked: new Set(),
    inboxKey: null,
    offline: false,
    override: null,
    pollIntervalSeconds: 1,
    fetch: (input, init) => Promise.resolve(answer(input, init)),
  };

  function tokenOf(request: SentRequest): string | Response {
    const header = request.headers["authorization"] ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (api.revoked.has(token)) return apiError(401, "token_revoked");
    if (!api.tokens.has(token)) return apiError(401, "unauthenticated");
    return token;
  }

  function answer(input: string, init: RequestInit): Response {
    if (api.offline) throw new TypeError("Failed to fetch");
    const url = new URL(input);
    if (url.origin !== ORIGIN) throw new TypeError("Failed to fetch");
    // the client always passes a plain object; read it as the server would, case-insensitively
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const request: SentRequest = {
      method: init.method ?? "GET",
      path: url.pathname,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    api.requests.push(request);
    if (headers["knowtarium-protocol-version"] !== "2") {
      return apiError(400, "unsupported_protocol");
    }
    if (request.method !== "GET" && headers["knowtarium-request"] !== "1") {
      return apiError(403, "forbidden");
    }
    const overridden = api.override?.(request);
    if (overridden !== undefined) return overridden;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const route = `${request.method} ${request.path}`;
    if (route === "POST /connect-requests") {
      if (body["client"] !== "extension" || typeof body["extensionVersion"] !== "string") {
        return apiError(400, "invalid_request");
      }
      const id = requestId();
      const pollSecret = `poll_${id}`;
      api.connect.set(id, { status: "pending", pollSecret });
      return json(201, {
        requestId: id,
        pollSecret,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        pollIntervalSeconds: api.pollIntervalSeconds,
      });
    }
    const poll = /^\/connect-requests\/([^/]+)\/poll$/.exec(request.path);
    if (request.method === "POST" && poll !== null) {
      const entry = api.connect.get(decodeURIComponent(poll[1] ?? ""));
      if (entry === undefined) return apiError(404, "not_found");
      if (body["pollSecret"] !== entry.pollSecret) return apiError(403, "forbidden");
      if (entry.status === "relayed" && entry.relay !== undefined) {
        const relay = entry.relay;
        entry.status = "completed";
        delete entry.relay;
        return json(200, { status: "relayed", encRelayPayload: relay });
      }
      if (entry.status === "pending" || entry.status === "approved") {
        return json(200, { status: entry.status, pollIntervalSeconds: api.pollIntervalSeconds });
      }
      return json(200, { status: entry.status });
    }
    if (route === "POST /extensions/current/clips") {
      const token = tokenOf(request);
      if (token instanceof Response) return token;
      const clipId = body["clipId"];
      const blob = body["blob"];
      if (typeof clipId !== "string" || typeof blob !== "string") {
        return apiError(400, "invalid_request");
      }
      const bytes = fromBase64Url(blob);
      if (bytes.length > 24 * 1024) return apiError(413, "payload_too_large");
      if (bytes[0] !== 1) return apiError(400, "invalid_request");
      const generation = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0);
      if (api.inboxKey === null) return apiError(409, "inbox_not_set");
      if (generation !== api.inboxKey.envelope.generation) {
        return apiError(409, "stale_inbox_key", { inboxKey: api.inboxKey });
      }
      const held = api.clips.get(clipId);
      if (held !== undefined) {
        return held === blob ? json(200, { status: "duplicate" }) : apiError(409, "already_exists");
      }
      if (api.filed.has(clipId)) return json(200, { status: "duplicate" });
      api.clips.set(clipId, blob);
      return json(201, { status: "queued" });
    }
    if (route === "GET /extensions/current/inbox-key") {
      const token = tokenOf(request);
      if (token instanceof Response) return token;
      if (api.inboxKey === null) return apiError(409, "inbox_not_set");
      return json(200, { inboxKey: api.inboxKey });
    }
    if (route === "DELETE /extensions/current") {
      const token = tokenOf(request);
      if (token instanceof Response) return token;
      api.revoked.add(token);
      return json(200, { ok: true });
    }
    return apiError(404, "not_found");
  }

  return api;
}

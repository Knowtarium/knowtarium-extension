import {
  type ClipInput,
  type ClipPayload,
  createClipId,
  fromBase64Url,
  isClipError,
  normalizeClip,
  signAndSealClip,
  toBase64Url,
} from "knowtarium/clip";

import type { ApiResult, ExtensionApi } from "./api";
import { checkInboxKey, cleanInboxKey } from "./inbox-key";
import type { Lock } from "./lock";
import {
  ALL_KEYS,
  type Connection,
  type QueuedClip,
  readConnection,
  type StateStore,
} from "./storage";

// Saving a clip, and the queue behind it. A clip is cleaned (`normalizeClip`), signed and sealed to
// the latest verified inbox key, written to the queue, then posted. It leaves the queue once the API
// has it (201 queued, or 200 duplicate). On a network error, a 5xx, a 404 (a server without the
// clipper yet) or a 429 it stays, and every later try sends the SAME sealed bytes, since the API
// answers a clip ID it holds with other bytes 409 `already_exists`. It is sealed again only after
// 409 `stale_inbox_key`, which carries the newer inbox key: verified under the pinned owner key,
// stored, then the clip is sealed to it and sent once more. Without the `alarms` permission the
// queue is sent when the popup opens and when the browser starts.

/** The most clips the queue holds. */
export const QUEUE_LIMIT = 100;
/** How often the popup reads the inbox key when it opens. */
export const INBOX_KEY_CHECK_MS = 24 * 60 * 60 * 1000;

/** The longest a Retry-After is followed: a day. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** The wait after a 429 that names none. */
export const DEFAULT_RETRY_AFTER_MS = 60 * 1000;

/** Why a clip waits in the queue. */
export type WaitReason =
  | "offline"
  | "server_error"
  | "not_updated"
  | "rate_limited"
  | "inbox_full"
  | "quota_exceeded"
  | "unverified_key"
  /** The API needs this extension connected again (403, or 409 inbox_not_set). */
  | "reconnect";

/** Why a clip was not kept (at save) or was dropped from the queue: it can never be taken. */
export type FailReason = "too_long" | "refused";

/** The fields of the popup's form. */
export interface ClipForm {
  readonly url: string;
  readonly title: string;
  readonly note: string;
  /** A category name, or "" for the inbox itself. */
  readonly category: string;
}

export type SaveResult =
  | { readonly kind: "saved"; readonly category: string; readonly duplicate: boolean }
  | {
      readonly kind: "queued";
      readonly reason: WaitReason;
      readonly category: string;
      /** Clips in the queue now, this one included. */
      readonly waiting: number;
      /** After a 429: when sending is tried again (ms since the epoch). */
      readonly retryAt?: number;
    }
  | { readonly kind: "failed"; readonly reason: FailReason }
  | {
      readonly kind: "invalid";
      readonly field: "url" | "title" | "note" | null;
      readonly code: "too_long" | "bad_url" | "invalid";
    }
  | { readonly kind: "queue_full" }
  | { readonly kind: "disconnected" };

export interface FlushResult {
  readonly sent: number;
  /** Clips the API refused for good (too long, malformed), removed from the queue. */
  readonly dropped: number;
  /** Clips still in the queue. */
  readonly waiting: number;
  /** Why sending stopped before the queue was empty, or null. */
  readonly stoppedBy: WaitReason | "disconnected" | null;
  /** After a 429: when sending is tried again (ms since the epoch). */
  readonly retryAt?: number;
}

export type InboxKeyRefresh =
  "skipped" | "same" | "updated" | "refused" | "unavailable" | "disconnected";

/** What one post came to. */
type Answer =
  | { readonly kind: "sent"; readonly duplicate: boolean }
  | { readonly kind: "wait"; readonly reason: WaitReason; readonly retryAfterSeconds?: number }
  | { readonly kind: "refused"; readonly reason: FailReason }
  | { readonly kind: "disconnected" };

/** The popup's answer to each API status (the design's table, "The extension"). */
export function classifyPost(result: ApiResult<unknown>): Answer {
  if (result.kind === "network") return { kind: "wait", reason: "offline" };
  if (result.kind === "ok") {
    const status = (result.body as { status?: unknown } | null)?.status;
    return { kind: "sent", duplicate: status === "duplicate" };
  }
  const { status, code } = result;
  if (status >= 500) return { kind: "wait", reason: "server_error" };
  if (status === 401) return { kind: "disconnected" };
  if (status === 404) return { kind: "wait", reason: "not_updated" };
  if (status === 429) {
    if (code === "inbox_full") return { kind: "wait", reason: "inbox_full" };
    return {
      kind: "wait",
      reason: "rate_limited",
      ...(result.retryAfterSeconds === null ? {} : { retryAfterSeconds: result.retryAfterSeconds }),
    };
  }
  if (status === 402) return { kind: "wait", reason: "quota_exceeded" };
  // only a clip the API can never take is dropped: one too long, or a malformed request
  if (status === 413) return { kind: "refused", reason: "too_long" };
  if (status === 400 && code === "invalid_request") return { kind: "refused", reason: "refused" };
  // a server that speaks another protocol version: one not updated yet, as a 404 is
  if (status === 400 && code === "unsupported_protocol") {
    return { kind: "wait", reason: "not_updated" };
  }
  // the clip ID is the extension's own and random, so the API holds it only from an earlier post
  // of this clip whose answer was lost (before a seal again): it has the clip
  if (status === 409 && code === "already_exists") return { kind: "sent", duplicate: true };
  if (status === 409 && code === "stale_inbox_key") return { kind: "wait", reason: "server_error" };
  if (status === 403 || (status === 409 && code === "inbox_not_set")) {
    return { kind: "wait", reason: "reconnect" };
  }
  return { kind: "wait", reason: "server_error" };
}

export interface ClipperDeps {
  readonly api: ExtensionApi;
  readonly store: StateStore;
  readonly apiOrigin: string;
  readonly lock: Lock;
  readonly now: () => number;
}

export interface Clipper {
  /** Cleans, seals, queues and sends a clip from the popup's form. */
  save(form: ClipForm): Promise<SaveResult>;
  /** Sends the queue, oldest first, until it is empty or the API can't take more now. */
  flush(): Promise<FlushResult>;
  /** Clips waiting in the queue. */
  waiting(): Promise<number>;
  /** Reads the inbox key when the last read is a day old (the popup does it when it opens). */
  refreshInboxKey(): Promise<InboxKeyRefresh>;
  /**
   * Revokes the token (best effort) and clears everything local, the queue included. Whether the
   * API confirmed it.
   */
  disconnect(): Promise<{ readonly revoked: boolean }>;
}

/** Clears everything local (Disconnect). */
export async function forgetEverything(store: StateStore): Promise<void> {
  await store.remove(ALL_KEYS);
}

/**
 * The server ended the connection (401): removes it, when it is still the one whose token got
 * the 401, and leaves a notice for the popup. The queue and the categories stay, with the
 * workspace they belong to, so connecting again to the same workspace sends the queue. Call it
 * inside the queue's lock.
 */
export async function endConnection(
  store: StateStore,
  apiOrigin: string,
  token: string,
): Promise<void> {
  const connection = await readConnection(store, apiOrigin);
  if (connection?.token !== token) return;
  const { accountId, workspaceId, workspaceName } = connection;
  await store.remove(["connection"]);
  await store.set({
    notice: "disconnected",
    previousWorkspace: { accountId, workspaceId, workspaceName },
  });
}

/** Which field made `normalizeClip` refuse the form, by trying it without the others. */
function invalidField(input: ClipInput, code: string): "url" | "title" | "note" | null {
  if (code === "bad_url") return "url";
  if (code !== "too_long") return null;
  const refuses = (candidate: ClipInput) => {
    try {
      normalizeClip(candidate);
      return false;
    } catch {
      return true;
    }
  };
  if (refuses({ ...input, title: "", note: "" })) return "url";
  if (refuses({ ...input, note: "" })) return "title";
  return "note";
}

function seal(connection: Connection, payload: ClipPayload): { blob: string; generation: number } {
  const { generation, publicKey } = connection.inboxKey.envelope;
  const sealed = signAndSealClip(payload, {
    signingSecretKey: fromBase64Url(connection.signSecretKey),
    inboxKey: { generation, publicKey },
  });
  return { blob: toBase64Url(sealed), generation };
}

export function createClipper(deps: ClipperDeps): Clipper {
  const { api, store, apiOrigin, lock, now } = deps;

  async function readQueue(): Promise<QueuedClip[]> {
    const { queue } = await store.get(["queue"]);
    return queue === undefined ? [] : [...queue];
  }

  async function writeQueue(queue: readonly QueuedClip[]): Promise<void> {
    await store.set({ queue });
  }

  /** When sending may be tried again after a 429, or null when it may now. */
  async function retryBlock(): Promise<number | null> {
    const { retryAt } = await store.get(["retryAt"]);
    return typeof retryAt === "number" && retryAt > now() ? retryAt : null;
  }

  async function clearRetry(): Promise<void> {
    await store.remove(["retryAt"]);
  }

  /** After a 429 rate limit: no sending until its Retry-After (at most a day), stored. */
  async function noteWait(answer: {
    readonly reason: WaitReason;
    readonly retryAfterSeconds?: number;
  }): Promise<number | null> {
    if (answer.reason !== "rate_limited") return null;
    const ms =
      answer.retryAfterSeconds === undefined
        ? DEFAULT_RETRY_AFTER_MS
        : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, answer.retryAfterSeconds * 1000));
    const retryAt = now() + ms;
    await store.set({ retryAt });
    return retryAt;
  }

  async function replaceItem(item: QueuedClip): Promise<void> {
    const queue = await readQueue();
    await writeQueue(queue.map((entry) => (entry.clipId === item.clipId ? item : entry)));
  }

  async function removeItem(clipId: string): Promise<number> {
    const queue = (await readQueue()).filter((entry) => entry.clipId !== clipId);
    await writeQueue(queue);
    return queue.length;
  }

  /**
   * Posts one clip; on `stale_inbox_key` checks the key in the answer, stores it, seals the same
   * payload to it, stores those bytes for any later retry and posts once more.
   */
  async function send(
    connection: Connection,
    item: QueuedClip,
  ): Promise<{ answer: Answer; connection: Connection }> {
    const result = await api.postClip(connection.token, { clipId: item.clipId, blob: item.blob });
    if (result.kind !== "error" || result.status !== 409 || result.code !== "stale_inbox_key") {
      return { answer: classifyPost(result), connection };
    }
    const signed = result.error?.["inboxKey"];
    const check = checkInboxKey(connection, signed);
    if (check === "refused") {
      return { answer: { kind: "wait", reason: "unverified_key" }, connection };
    }
    // the key the server names is the one this clip is sealed to: sealing again changes nothing
    if (check === "same" && item.generation === connection.inboxKey.envelope.generation) {
      return { answer: { kind: "wait", reason: "server_error" }, connection };
    }
    let current = connection;
    if (check === "newer") {
      current = {
        ...connection,
        inboxKey: cleanInboxKey(signed as Connection["inboxKey"]),
        inboxKeyCheckedAt: now(),
      };
      await store.set({ connection: current });
    }
    const resealed: QueuedClip = { ...item, ...seal(current, item.payload) };
    await replaceItem(resealed);
    const again = await api.postClip(current.token, {
      clipId: resealed.clipId,
      blob: resealed.blob,
    });
    return { answer: classifyPost(again), connection: current };
  }

  async function saveLocked(form: ClipForm): Promise<SaveResult> {
    const connection = await readConnection(store, apiOrigin);
    if (connection === undefined) return { kind: "disconnected" };
    const input: ClipInput = {
      clipId: createClipId(),
      workspaceId: connection.workspaceId,
      extensionId: connection.extensionId,
      url: form.url,
      title: form.title,
      note: form.note,
      category: form.category,
      savedAt: new Date(now()).toISOString(),
    };
    let item: QueuedClip;
    try {
      const payload = normalizeClip(input);
      item = {
        clipId: payload.clipId,
        payload,
        ...seal(connection, payload),
        queuedAt: new Date(now()).toISOString(),
      };
    } catch (error) {
      if (!isClipError(error)) throw error;
      const code = error.code === "too_long" || error.code === "bad_url" ? error.code : "invalid";
      return { kind: "invalid", field: invalidField(input, error.code), code };
    }
    const category = item.payload.category;
    const queue = await readQueue();
    if (queue.length >= QUEUE_LIMIT) return { kind: "queue_full" };
    // written before it is sent, so a popup closed mid-request loses nothing
    await writeQueue([...queue, item]);
    const blockedUntil = await retryBlock();
    if (blockedUntil !== null) {
      return {
        kind: "queued",
        reason: "rate_limited",
        category,
        waiting: queue.length + 1,
        retryAt: blockedUntil,
      };
    }
    const { answer } = await send(connection, item);
    switch (answer.kind) {
      case "sent":
        await removeItem(item.clipId);
        await clearRetry();
        return { kind: "saved", category, duplicate: answer.duplicate };
      case "wait": {
        const retryAt = await noteWait(answer);
        return {
          kind: "queued",
          reason: answer.reason,
          category,
          waiting: (await readQueue()).length,
          ...(retryAt === null ? {} : { retryAt }),
        };
      }
      case "refused":
        await removeItem(item.clipId);
        return { kind: "failed", reason: answer.reason };
      case "disconnected":
        // the clip stays queued for the same workspace's next connection
        await endConnection(store, apiOrigin, connection.token);
        return { kind: "disconnected" };
    }
  }

  return {
    save(form) {
      // all of it under the lock, so a pairing finishing meanwhile can't mix two workspaces
      return lock(() => saveLocked(form));
    },

    flush() {
      return lock(async () => {
        let connection = await readConnection(store, apiOrigin);
        let queue = await readQueue();
        if (connection === undefined || queue.length === 0) {
          return { sent: 0, dropped: 0, waiting: queue.length, stoppedBy: null };
        }
        const blockedUntil = await retryBlock();
        if (blockedUntil !== null) {
          return {
            sent: 0,
            dropped: 0,
            waiting: queue.length,
            stoppedBy: "rate_limited",
            retryAt: blockedUntil,
          };
        }
        let sent = 0;
        let dropped = 0;
        for (const item of queue) {
          const outcome = await send(connection, item);
          connection = outcome.connection;
          const { answer } = outcome;
          if (answer.kind === "sent" || answer.kind === "refused") {
            if (answer.kind === "sent") {
              sent += 1;
              await clearRetry();
            } else {
              dropped += 1;
            }
            await removeItem(item.clipId);
            continue;
          }
          if (answer.kind === "disconnected") {
            await endConnection(store, apiOrigin, connection.token);
            return {
              sent,
              dropped,
              waiting: (await readQueue()).length,
              stoppedBy: "disconnected",
            };
          }
          queue = await readQueue();
          const retryAt = await noteWait(answer);
          return {
            sent,
            dropped,
            waiting: queue.length,
            stoppedBy: answer.reason,
            ...(retryAt === null ? {} : { retryAt }),
          };
        }
        return { sent, dropped, waiting: (await readQueue()).length, stoppedBy: null };
      });
    },

    async waiting() {
      return (await readQueue()).length;
    },

    async refreshInboxKey() {
      const connection = await readConnection(store, apiOrigin);
      if (connection === undefined) return "disconnected";
      if (now() - connection.inboxKeyCheckedAt < INBOX_KEY_CHECK_MS) return "skipped";
      const result = await api.getInboxKey(connection.token);
      if (result.kind === "error" && result.status === 401) {
        await lock(() => endConnection(store, apiOrigin, connection.token));
        return "disconnected";
      }
      if (result.kind !== "ok") return "unavailable";
      const signed = (result.body as { inboxKey?: unknown } | null)?.inboxKey;
      const check = checkInboxKey(connection, signed);
      // a key that doesn't verify is not taken; the next try is a day later all the same
      const next: Connection =
        check === "newer"
          ? {
              ...connection,
              inboxKey: cleanInboxKey(signed as Connection["inboxKey"]),
              inboxKeyCheckedAt: now(),
            }
          : { ...connection, inboxKeyCheckedAt: now() };
      await lock(async () => {
        // only when the connection is still the one read above
        const still = await readConnection(store, apiOrigin);
        if (still?.token === connection.token) await store.set({ connection: next });
      });
      return check === "newer" ? "updated" : check;
    },

    disconnect() {
      return lock(async () => {
        const connection = await readConnection(store, apiOrigin);
        let revoked = false;
        if (connection !== undefined) {
          const result = await api.revoke(connection.token);
          revoked = result.kind === "ok" || (result.kind === "error" && result.status === 401);
        }
        await forgetEverything(store);
        return { revoked };
      });
    },
  };
}

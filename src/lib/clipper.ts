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

/** Why a clip waits in the queue. */
export type WaitReason =
  "offline" | "server_error" | "not_updated" | "rate_limited" | "inbox_full" | "unverified_key";

/** Why a clip was not kept (at save) or was dropped from the queue. */
export type FailReason = "too_long" | "quota_exceeded" | "refused";

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
  readonly stoppedBy: WaitReason | "quota_exceeded" | "disconnected" | null;
}

export type InboxKeyRefresh =
  "skipped" | "same" | "updated" | "refused" | "unavailable" | "disconnected";

/** What one post came to. */
type Answer =
  | { readonly kind: "sent"; readonly duplicate: boolean }
  | { readonly kind: "wait"; readonly reason: WaitReason }
  | { readonly kind: "full" }
  | { readonly kind: "refused"; readonly reason: "too_long" | "refused" }
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
    return { kind: "wait", reason: code === "inbox_full" ? "inbox_full" : "rate_limited" };
  }
  if (status === 402) return { kind: "full" };
  if (status === 413) return { kind: "refused", reason: "too_long" };
  // the clip ID is the extension's own and random, so the API holds it only from an earlier post
  // of this clip whose answer was lost (before a seal again): it has the clip
  if (status === 409 && code === "already_exists") return { kind: "sent", duplicate: true };
  if (status === 409 && code === "stale_inbox_key") return { kind: "wait", reason: "server_error" };
  return { kind: "refused", reason: "refused" };
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
    const { answer } = await send(connection, item);
    switch (answer.kind) {
      case "sent":
        await removeItem(item.clipId);
        return { kind: "saved", category, duplicate: answer.duplicate };
      case "wait":
        return {
          kind: "queued",
          reason: answer.reason,
          category,
          waiting: (await readQueue()).length,
        };
      case "full":
        await removeItem(item.clipId);
        return { kind: "failed", reason: "quota_exceeded" };
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
        let sent = 0;
        let dropped = 0;
        for (const item of queue) {
          const outcome = await send(connection, item);
          connection = outcome.connection;
          const { answer } = outcome;
          if (answer.kind === "sent" || answer.kind === "refused") {
            if (answer.kind === "sent") sent += 1;
            else dropped += 1;
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
          return {
            sent,
            dropped,
            waiting: queue.length,
            stoppedBy: answer.kind === "full" ? "quota_exceeded" : answer.reason,
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

import type { ClipPayload, SignedInboxKey } from "knowtarium/clip";

// Everything the extension keeps, all in chrome.storage.local (never sync storage, so nothing leaves
// the device): the connection made at pairing, the category names and the send queue, plus a notice
// for the popup when the server ended the connection. Disconnect clears all of it.

/** What pairing stores; one workspace per install. */
export interface Connection {
  readonly v: 1;
  /** The API this connection was made with; a build for another environment ignores it. */
  readonly apiOrigin: string;
  /** The extension's token (`kte_...`). */
  readonly token: string;
  readonly extensionId: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** The owner's Ed25519 public key from the sealed pairing payload (base64url), pinned. */
  readonly ownerSigningPublicKey: string;
  /** The extension's own Ed25519 key pair (base64url; the secret key in libsodium's 64 bytes). */
  readonly signPublicKey: string;
  readonly signSecretKey: string;
  /** The latest owner-signed inbox key this extension verified. */
  readonly inboxKey: SignedInboxKey;
  /** When the inbox key was last read from the API (ms since the epoch). */
  readonly inboxKeyCheckedAt: number;
  readonly connectedAt: string;
}

/** A clip waiting to be sent: the fixed payload and the exact sealed bytes every retry sends. */
export interface QueuedClip {
  readonly clipId: string;
  readonly payload: ClipPayload;
  /** The sealed clip, base64url. */
  readonly blob: string;
  /** The inbox key generation it is sealed to. */
  readonly generation: number;
  readonly queuedAt: string;
}

/** Why the popup should say the connection ended, when it did so without the person. */
export type Notice = "disconnected";

/** The workspace a connection was for, kept after the server ended it (401). */
export interface WorkspaceRef {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

export interface StoredState {
  readonly connection?: Connection;
  /**
   * After a 401, the workspace the ended connection was for: the queue and the categories stay,
   * and connecting again to this same account and workspace sends the queue.
   */
  readonly previousWorkspace?: WorkspaceRef;
  readonly categories?: readonly string[];
  readonly queue?: readonly QueuedClip[];
  readonly notice?: Notice;
}

export type StateKey = keyof StoredState;

/** The storage area the extension uses, as an interface so tests can keep it in memory. */
export interface StateStore {
  get<K extends StateKey>(keys: readonly K[]): Promise<Pick<StoredState, K>>;
  set(values: StoredState): Promise<void>;
  remove(keys: readonly StateKey[]): Promise<void>;
}

export const ALL_KEYS: readonly StateKey[] = [
  "connection",
  "previousWorkspace",
  "categories",
  "queue",
  "notice",
];

/** chrome.storage.local. */
export function chromeStore(area: chrome.storage.StorageArea = chrome.storage.local): StateStore {
  return {
    async get(keys) {
      return area.get<Pick<StoredState, (typeof keys)[number]>>([...keys]);
    },
    async set(values) {
      await area.set(values);
    },
    async remove(keys) {
      await area.remove([...keys]);
    },
  };
}

/** A store in memory, for tests. Values are copied in and out, as chrome.storage does. */
export function memoryStore(initial: StoredState = {}): StateStore & {
  readonly snapshot: () => StoredState;
} {
  let data = structuredClone(initial) as Record<string, unknown>;
  return {
    get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in data) out[key] = structuredClone(data[key]);
      }
      return Promise.resolve(out as never);
    },
    set(values) {
      data = { ...data, ...structuredClone(values) };
      return Promise.resolve();
    },
    remove(keys) {
      data = Object.fromEntries(
        Object.entries(data).filter(([key]) => !(keys as readonly string[]).includes(key)),
      );
      return Promise.resolve();
    },
    snapshot: (): StoredState => structuredClone(data),
  };
}

/** The workspace the queue and categories belong to: the connection's, or the one a 401 ended. */
export async function queueWorkspace(
  store: StateStore,
  apiOrigin: string,
): Promise<WorkspaceRef | undefined> {
  const connection = await readConnection(store, apiOrigin);
  if (connection !== undefined) return connection;
  const { previousWorkspace } = await store.get(["previousWorkspace"]);
  return previousWorkspace;
}

/** Whether two references name the same workspace of the same account. */
export function sameWorkspace(a: WorkspaceRef | undefined, b: WorkspaceRef): boolean {
  return a?.accountId === b.accountId && a.workspaceId === b.workspaceId;
}

/** The connection for this build's API, or undefined when there is none (or one for another). */
export async function readConnection(
  store: StateStore,
  apiOrigin: string,
): Promise<Connection | undefined> {
  const { connection } = await store.get(["connection"]);
  return connection?.v === 1 && connection.apiOrigin === apiOrigin ? connection : undefined;
}

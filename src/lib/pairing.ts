import {
  createConnectSecret,
  createExtensionKeys,
  EXTENSION_CONNECT_PAGE_PATH,
  extensionConfirmationCode,
  formatExtensionConnectFragment,
  fromBase64Url,
  isClipError,
  normalizeClip,
  openExtensionPairing,
  ready,
  signAndSealClip,
  toBase64Url,
} from "knowtarium/clip";

import type { ExtensionApi } from "./api";
import { categoriesAfterPairing } from "./categories";
import { cleanInboxKey } from "./inbox-key";
import type { Lock } from "./lock";
import { type Connection, type QueuedClip, readConnection, type StateStore } from "./storage";

// Pairing, as pair.html runs it ("Pairing" in the design). When it starts, and never at install,
// it makes the extension's Ed25519 key pair and a one-time secret, starts a connect request
// (`client: "extension"`), shows the confirmation code at once and opens the web app's
// /connect/extension with the key and the secret in the fragment. The person matches the code
// there before Allow. The page then polls until the web app relays the sealed payload, opens it
// with the secret, checks that the owner vouched for exactly this key (`extension_key`) and signed
// the inbox key (`inbox_key`) under the owner key in the payload, and stores everything. There is
// no second code check: the code was matched before anything was approved.

/** Shortest and longest wait between two polls. */
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 10_000;
/** How long an answer may be late after the request's expiry before the page gives up. */
const EXPIRY_GRACE_MS = 5_000;

const REQUEST_ID = /^cr_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export type PairingFailure =
  /** No answer from the API. */
  | "offline"
  /** The API doesn't know extension pairing yet (404, or 400 for the new request shape). */
  | "not_updated"
  | "rate_limited"
  | "server_error"
  | "expired"
  | "denied"
  /** The request was collected already (another tab of this page, most likely). */
  | "used"
  /** The relayed payload doesn't open with the secret, or has the wrong shape. */
  | "bad_payload"
  /** The owner's `extension_key` doesn't vouch for this extension's own key. */
  | "wrong_key"
  /** The `inbox_key` isn't signed by the owner for that account and workspace. */
  | "bad_signature"
  | "cancelled";

export type PairingResult =
  | { readonly ok: true; readonly workspaceName: string; readonly categories: number }
  | { readonly ok: false; readonly reason: PairingFailure };

export type PairingEvent =
  /** Show the code now; the web app's page is being opened at `connectUrl`. */
  | { readonly step: "code"; readonly code: string; readonly connectUrl: string }
  /** The person allowed in the web app; the payload comes next. */
  | { readonly step: "approved" };

export interface PairingDeps {
  readonly api: ExtensionApi;
  readonly store: StateStore;
  readonly lock: Lock;
  readonly apiOrigin: string;
  readonly appOrigin: string;
  readonly extensionVersion: string;
  /** Opens the web app's page in a new tab (`chrome.tabs.create`, which needs no permission). */
  readonly openTab: (url: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pollDelay(seconds: unknown): number {
  const ms = typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : 2_000;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, ms));
}

/** The page the extension opens: `<app>/connect/extension?request=<id>#signPublicKey=...&secret=...` */
export function connectUrl(
  appOrigin: string,
  requestId: string,
  link: { readonly signPublicKey: Uint8Array; readonly secret: Uint8Array },
): string {
  return `${appOrigin}${EXTENSION_CONNECT_PAGE_PATH}?request=${encodeURIComponent(requestId)}#${formatExtensionConnectFragment(link)}`;
}

/**
 * Queued clips were signed by the previous connection's key for its extension ID: a filer would
 * refuse them under the new one. Sign and seal the same payloads (same clip IDs and save times)
 * as this extension, for the newly paired workspace.
 */
function rebindQueue(queue: readonly QueuedClip[], connection: Connection): QueuedClip[] {
  const out: QueuedClip[] = [];
  for (const item of queue) {
    try {
      const payload = normalizeClip({
        ...item.payload,
        workspaceId: connection.workspaceId,
        extensionId: connection.extensionId,
      });
      const { generation, publicKey } = connection.inboxKey.envelope;
      const sealed = signAndSealClip(payload, {
        signingSecretKey: fromBase64Url(connection.signSecretKey),
        inboxKey: { generation, publicKey },
      });
      out.push({ ...item, payload, blob: toBase64Url(sealed), generation });
    } catch {
      // a clip that can't be sealed again is left out
    }
  }
  return out;
}

/** Runs one pairing from start to stored connection. Never throws for the API's answers. */
export async function pair(
  deps: PairingDeps,
  onEvent: (event: PairingEvent) => void,
  signal?: AbortSignal,
): Promise<PairingResult> {
  const { api, store, now } = deps;
  await ready();
  const keys = createExtensionKeys();
  const secret = createConnectSecret();
  const fail = (reason: PairingFailure): PairingResult => ({ ok: false, reason });
  const cancelled = () => signal?.aborted === true;
  try {
    const started = await api.startConnect(deps.extensionVersion);
    if (started.kind === "network") return fail("offline");
    if (started.kind === "error") {
      if (started.status === 404 || started.status === 400) return fail("not_updated");
      if (started.status === 429) return fail("rate_limited");
      return fail("server_error");
    }
    const body: unknown = started.body;
    if (
      !isRecord(body) ||
      typeof body["requestId"] !== "string" ||
      !REQUEST_ID.test(body["requestId"]) ||
      typeof body["pollSecret"] !== "string" ||
      typeof body["expiresAt"] !== "string"
    ) {
      return fail("server_error");
    }
    const requestId = body["requestId"];
    const pollSecret = body["pollSecret"];
    // a server's time that doesn't parse gets the connect requests' 10 minutes
    const parsedExpiry = Date.parse(body["expiresAt"]);
    const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : now() + 600_000;
    let delay = pollDelay(body["pollIntervalSeconds"]);

    const url = connectUrl(deps.appOrigin, requestId, { signPublicKey: keys.publicKey, secret });
    onEvent({
      step: "code",
      code: extensionConfirmationCode(keys.publicKey, requestId),
      connectUrl: url,
    });
    await deps.openTab(url);

    let approved = false;
    let relayed: string | undefined;
    while (relayed === undefined) {
      if (cancelled()) return fail("cancelled");
      if (now() > expiresAt + EXPIRY_GRACE_MS) return fail("expired");
      await deps.sleep(delay);
      if (cancelled()) return fail("cancelled");
      const polled = await api.pollConnect(requestId, pollSecret);
      if (polled.kind === "network") continue;
      if (polled.kind === "error") {
        if (polled.status === 429) {
          delay = Math.min(60_000, Math.max(delay, (polled.retryAfterSeconds ?? 10) * 1000));
          continue;
        }
        if (polled.status >= 500) continue;
        if (polled.status === 410 || polled.status === 404) return fail("expired");
        return fail("server_error");
      }
      const answer: unknown = polled.body;
      if (!isRecord(answer)) return fail("server_error");
      switch (answer["status"]) {
        case "pending":
          delay = pollDelay(answer["pollIntervalSeconds"]);
          break;
        case "approved":
          delay = pollDelay(answer["pollIntervalSeconds"]);
          if (!approved) onEvent({ step: "approved" });
          approved = true;
          break;
        case "relayed":
          if (typeof answer["encRelayPayload"] !== "string") return fail("bad_payload");
          relayed = answer["encRelayPayload"];
          break;
        case "denied":
          return fail("denied");
        case "expired":
          return fail("expired");
        case "completed":
          return fail("used");
        default:
          return fail("server_error");
      }
    }

    let sealed: Uint8Array;
    try {
      sealed = fromBase64Url(relayed);
    } catch {
      return fail("bad_payload");
    }
    let pairing;
    try {
      pairing = openExtensionPairing(sealed, { secret, signPublicKey: keys.publicKey });
    } catch (error) {
      if (isClipError(error, "wrong_key")) return fail("wrong_key");
      if (isClipError(error, "bad_signature")) return fail("bad_signature");
      return fail("bad_payload");
    }

    const connection: Connection = {
      v: 1,
      apiOrigin: deps.apiOrigin,
      token: pairing.token,
      extensionId: pairing.extensionId,
      accountId: pairing.accountId,
      workspaceId: pairing.workspaceId,
      workspaceName: pairing.workspaceName,
      ownerSigningPublicKey: toBase64Url(pairing.ownerSigningPublicKey),
      signPublicKey: toBase64Url(keys.publicKey),
      signSecretKey: toBase64Url(keys.privateKey),
      inboxKey: cleanInboxKey(pairing.inboxKey),
      inboxKeyCheckedAt: now(),
      connectedAt: new Date(now()).toISOString(),
    };

    const previous = await deps.lock(async () => {
      const before = await readConnection(store, deps.apiOrigin);
      const stored = await store.get(["categories", "queue"]);
      const categories = categoriesAfterPairing(
        stored.categories ?? [],
        pairing.categories,
        before?.workspaceId === connection.workspaceId,
      );
      await store.set({
        connection,
        categories,
        queue: rebindQueue(stored.queue ?? [], connection),
      });
      await store.remove(["notice"]);
      return { before, categories: categories.length };
    });
    // the connection this one replaces stops working (best effort; the web app can revoke it too)
    if (previous.before !== undefined && previous.before.token !== connection.token) {
      await api.revoke(previous.before.token);
    }
    return { ok: true, workspaceName: pairing.workspaceName, categories: previous.categories };
  } finally {
    secret.fill(0);
    keys.privateKey.fill(0);
  }
}

import { createExtensionKeys, toBase64Url } from "knowtarium/clip";

import { createApi } from "../../src/lib/api";
import { type Clipper, createClipper } from "../../src/lib/clipper";
import { localLock, type Lock } from "../../src/lib/lock";
import { type Connection, memoryStore, type QueuedClip } from "../../src/lib/storage";
import { fakeApi, type FakeApi, ORIGIN } from "./fake-api";
import { makeOwner, type Owner, testId } from "./owner";

export interface Connected {
  readonly api: FakeApi;
  readonly owner: Owner;
  readonly store: ReturnType<typeof memoryStore>;
  readonly clipper: Clipper;
  /** The lock the clipper takes turns through (pairing shares it). */
  readonly lock: Lock;
  readonly connection: Connection;
  readonly signPublicKey: Uint8Array;
  /** The clock the clipper reads; tests move it. */
  clock: number;
}

/** A paired extension (as pairing leaves it) against a fake API that knows its token and key. */
export function connected(
  options: { categories?: string[]; queue?: QueuedClip[] } = {},
): Connected {
  const api = fakeApi();
  const owner = makeOwner();
  const keys = createExtensionKeys();
  const token = `kte_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const inboxKey = owner.inboxKey(1);
  api.tokens.add(token);
  api.inboxKey = inboxKey;
  const connection: Connection = {
    v: 1,
    apiOrigin: ORIGIN,
    token,
    extensionId: testId("ext"),
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    workspaceName: "Research",
    ownerSigningPublicKey: toBase64Url(owner.signing.publicKey),
    signPublicKey: toBase64Url(keys.publicKey),
    signSecretKey: toBase64Url(keys.privateKey),
    inboxKey,
    inboxKeyCheckedAt: Date.parse("2026-10-08T09:00:00.000Z"),
    connectedAt: "2026-10-10T09:00:00.000Z",
  };
  const store = memoryStore({
    connection,
    categories: options.categories ?? ["Reading"],
    queue: options.queue ?? [],
  });
  const lock = localLock();
  const state: Connected = {
    lock,
    api,
    owner,
    store,
    connection,
    signPublicKey: keys.publicKey,
    clock: Date.parse("2026-10-10T10:00:00.000Z"),
    clipper: createClipper({
      api: createApi(ORIGIN, api.fetch),
      store,
      apiOrigin: ORIGIN,
      lock,
      now: () => state.clock,
    }),
  };
  return state;
}

export const PAGE = {
  url: "https://example.com/blog/faster-builds",
  title: "How we sped up our build",
};

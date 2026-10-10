import { fromBase64Url, type SignedInboxKey, verifyInboxKey } from "knowtarium/clip";

import type { Connection } from "./storage";

// A new inbox key reaches the extension in two ways: in a 409 `stale_inbox_key` answer, and from
// the daily read of `GET /extensions/current/inbox-key`. Either way it is only accepted when it is
// signed by the owner key pinned at pairing (never one from a server answer), for the paired
// account and workspace, at a higher revision and not an older generation than the one verified.

export type InboxKeyCheck = "same" | "newer" | "refused";

function sameKey(a: SignedInboxKey, b: SignedInboxKey): boolean {
  const x = a.envelope;
  const y = b.envelope;
  return (
    a.signature === b.signature &&
    x.accountId === y.accountId &&
    x.workspaceId === y.workspaceId &&
    x.createdAt === y.createdAt &&
    x.revision === y.revision &&
    x.generation === y.generation &&
    x.publicKey === y.publicKey &&
    x.folderId === y.folderId
  );
}

/** Whether `signed` is the inbox key the extension holds, a newer one to accept, or neither. */
export function checkInboxKey(connection: Connection, signed: unknown): InboxKeyCheck {
  if (typeof signed !== "object" || signed === null) return "refused";
  const candidate = signed as SignedInboxKey;
  if (typeof candidate.envelope !== "object" || (candidate.envelope as unknown) === null) {
    return "refused";
  }
  if (sameKey(candidate, connection.inboxKey)) return "same";
  const current = connection.inboxKey.envelope;
  let ownerSigningPublicKey: Uint8Array;
  try {
    ownerSigningPublicKey = fromBase64Url(connection.ownerSigningPublicKey);
  } catch {
    return "refused";
  }
  return verifyInboxKey(candidate, {
    ownerSigningPublicKey,
    accountId: connection.accountId,
    workspaceId: connection.workspaceId,
    minRevision: current.revision + 1,
    minGeneration: current.generation,
  })
    ? "newer"
    : "refused";
}

/** Only the envelope's own fields, so nothing a server added rides along into storage. */
export function cleanInboxKey(signed: SignedInboxKey): SignedInboxKey {
  const e = signed.envelope;
  return {
    envelope: {
      type: e.type,
      accountId: e.accountId,
      workspaceId: e.workspaceId,
      createdAt: e.createdAt,
      revision: e.revision,
      generation: e.generation,
      publicKey: e.publicKey,
      folderId: e.folderId,
    },
    signature: signed.signature,
  };
}

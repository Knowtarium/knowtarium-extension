// The web app's side of the extension, for tests: the owner's account keys, a workspace key with its
// derived inbox key, the owner-signed `inbox_key` and `extension_key`, and the sealed pairing
// payload, all made with the SDK's own knowtarium/crypto (never shipped in the extension). Opening
// a sealed clip uses knowtarium/client's `openClip`, as a filer would.

import { clipSignedBy, openClip } from "knowtarium/client";
import { ready as clipReady, type SignedExtensionKey, type SignedInboxKey } from "knowtarium/clip";
import {
  createAccountKeys,
  createWorkspaceKey,
  deriveInboxKeyPair,
  ready as cryptoReady,
  rotateWorkspaceKey,
  sealExtensionPairing,
  type SigningKeyPair,
  signEnvelope,
  toBase64Url,
  type WorkspaceKey,
} from "knowtarium/crypto";

export async function readyAll(): Promise<void> {
  await cryptoReady();
  await clipReady();
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A random ID in the protocol's format (`<prefix>_` and 26 base32 digits, the first 0 to 7). */
export function testId(prefix: string): string {
  let body = String(Math.floor(Math.random() * 8));
  for (let i = 0; i < 25; i++) body += ID_ALPHABET.charAt(Math.floor(Math.random() * 32));
  return `${prefix}_${body}`;
}

export interface Owner {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly folderId: string;
  readonly signing: SigningKeyPair;
  key: WorkspaceKey;
  /** Signs the inbox key of `key` at `revision` (by default with the owner's key). */
  inboxKey(revision: number, options?: InboxKeyOptions): SignedInboxKey;
  extensionKey(
    extensionId: string,
    signPublicKey: Uint8Array,
    options?: { signer?: SigningKeyPair },
  ): SignedExtensionKey;
  /** Moves to the next workspace key generation. */
  rotate(): void;
  /** Opens a sealed clip as a filer would, and checks its signature under `signPublicKey`. */
  openClip(
    blob: Uint8Array,
    signPublicKey: Uint8Array,
  ): { payload: Record<string, unknown>; signed: boolean } | null;
}

export interface InboxKeyOptions {
  readonly signer?: SigningKeyPair;
  readonly key?: WorkspaceKey;
  readonly accountId?: string;
  readonly workspaceId?: string;
  /** A public key other than the derived one (a swapped key). */
  readonly publicKey?: Uint8Array;
}

function createdAt(): string {
  return new Date().toISOString();
}

export function makeOwner(): Owner {
  const account = createAccountKeys();
  const first = createWorkspaceKey();
  const keys = new Map<number, WorkspaceKey>([[first.generation, first]]);
  const owner: Owner = {
    accountId: testId("acc"),
    workspaceId: testId("ws"),
    folderId: testId("fld"),
    signing: account.signing,
    key: first,
    inboxKey(revision, options = {}) {
      const key = options.key ?? owner.key;
      const publicKey = options.publicKey ?? deriveInboxKeyPair(key).publicKey;
      const signed = signEnvelope(
        {
          type: "inbox_key",
          accountId: options.accountId ?? owner.accountId,
          workspaceId: options.workspaceId ?? owner.workspaceId,
          createdAt: createdAt(),
          revision,
          generation: key.generation,
          publicKey: toBase64Url(publicKey),
          folderId: owner.folderId,
        },
        options.signer ?? owner.signing,
      );
      return { envelope: signed.envelope, signature: signed.signature } as SignedInboxKey;
    },
    extensionKey(extensionId, signPublicKey, options = {}) {
      const signed = signEnvelope(
        {
          type: "extension_key",
          accountId: owner.accountId,
          workspaceId: owner.workspaceId,
          createdAt: createdAt(),
          extensionId,
          signPublicKey: toBase64Url(signPublicKey),
        },
        options.signer ?? owner.signing,
      );
      return { envelope: signed.envelope, signature: signed.signature } as SignedExtensionKey;
    },
    rotate() {
      owner.key = rotateWorkspaceKey(owner.key);
      keys.set(owner.key.generation, owner.key);
    },
    openClip(blob, signPublicKey) {
      const generation = new DataView(blob.buffer, blob.byteOffset + 1, 4).getUint32(0);
      const key = keys.get(generation);
      if (key === undefined) return null;
      const opened = openClip(blob, deriveInboxKeyPair(key));
      if (!opened.ok) return null;
      return {
        payload: opened.clip.payload as unknown as Record<string, unknown>,
        signed: clipSignedBy(opened.clip, signPublicKey),
      };
    },
  };
  return owner;
}

export interface PairingPayloadOptions {
  readonly token?: string;
  readonly extensionId?: string;
  readonly workspaceName?: string;
  readonly categories?: readonly string[];
  /** The `extension_key` to send (by default the owner's over the link's key). */
  readonly extensionKey?: SignedExtensionKey;
  /** The `inbox_key` to send (by default the owner's at revision 1). */
  readonly inboxKey?: SignedInboxKey;
  /** The owner key the payload names (by default the real one). */
  readonly ownerSigningPublicKey?: Uint8Array;
}

/** The sealed pairing payload the web app relays, as base64url. */
export function pairingPayload(
  owner: Owner,
  link: { readonly secret: Uint8Array; readonly signPublicKey: Uint8Array },
  options: PairingPayloadOptions = {},
): { relayed: string; token: string; extensionId: string } {
  const extensionId = options.extensionId ?? testId("ext");
  const token = options.token ?? `kte_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const sealed = sealExtensionPairing(
    {
      token,
      extensionId,
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      workspaceName: options.workspaceName ?? "Research",
      ownerSigningPublicKey: options.ownerSigningPublicKey ?? owner.signing.publicKey,
      extensionKey: options.extensionKey ?? owner.extensionKey(extensionId, link.signPublicKey),
      inboxKey: options.inboxKey ?? owner.inboxKey(1),
      categories: options.categories ?? ["Reading", "Work"],
    },
    link,
  );
  return { relayed: toBase64Url(sealed), token, extensionId };
}

import {
  createExtensionKeys,
  extensionConfirmationCode,
  fromBase64Url,
  toBase64Url,
} from "knowtarium/clip";
import { createAccountKeys, createWorkspaceKey, deriveInboxKeyPair } from "knowtarium/crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/lib/api";
import { localLock } from "../src/lib/lock";
import { pair, type PairingDeps, type PairingEvent } from "../src/lib/pairing";
import { memoryStore, type QueuedClip, type StoredState } from "../src/lib/storage";
import { apiError, fakeApi, type FakeApi, json, ORIGIN } from "./helpers/fake-api";
import {
  makeOwner,
  type Owner,
  pairingPayload,
  type PairingPayloadOptions,
  readyAll,
} from "./helpers/owner";

const APP = "https://app.test";

beforeAll(readyAll);

/** What the test's web app does once the extension opened its page. */
type WebApp = (link: {
  requestId: string;
  signPublicKey: Uint8Array;
  secret: Uint8Array;
}) => PairingPayloadOptions | "deny" | "expire" | "nothing";

interface Setup {
  api: FakeApi;
  owner: Owner;
  store: ReturnType<typeof memoryStore>;
  events: PairingEvent[];
  opened: string[];
  deps: PairingDeps;
}

let setup: Setup;

function makeSetup(
  webApp: WebApp = () => ({}),
  shared: { api?: FakeApi; owner?: Owner; store?: ReturnType<typeof memoryStore> } = {},
): Setup {
  const api = shared.api ?? fakeApi();
  const owner = shared.owner ?? makeOwner();
  const store = shared.store ?? memoryStore();
  const events: PairingEvent[] = [];
  const opened: string[] = [];
  const deps: PairingDeps = {
    api: createApi(ORIGIN, api.fetch),
    store,
    lock: localLock(),
    apiOrigin: ORIGIN,
    appOrigin: APP,
    extensionVersion: "0.1.0",
    openTab: (url) => {
      opened.push(url);
      const page = new URL(url);
      const requestId = page.searchParams.get("request") ?? "";
      const fragment = new URLSearchParams(page.hash.slice(1));
      const link = {
        requestId,
        signPublicKey: fromBase64Url(fragment.get("signPublicKey") ?? ""),
        secret: fromBase64Url(fragment.get("secret") ?? ""),
      };
      const entry = api.connect.get(requestId);
      if (entry === undefined) throw new Error("no such request");
      const action = webApp(link);
      if (action === "deny") entry.status = "denied";
      else if (action === "expire") entry.status = "expired";
      else if (action !== "nothing") {
        const payload = pairingPayload(owner, link, action);
        api.tokens.add(payload.token);
        entry.status = "relayed";
        entry.relay = payload.relayed;
      }
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
  };
  return { api, owner, store, events, opened, deps };
}

function run(s: Setup = setup) {
  return pair(s.deps, (event) => s.events.push(event));
}

describe("pairing", () => {
  beforeEach(() => {
    setup = makeSetup();
  });

  it("makes its keys when pairing starts, shows the code at once and stores the connection", async () => {
    expect(setup.store.snapshot()).toEqual({});
    const result = await run();
    expect(result).toEqual({
      ok: true,
      workspaceName: "Research",
      categories: 2,
      kept: 0,
      discarded: 0,
      discardedFrom: null,
    });

    const start = setup.api.requests[0];
    expect(start?.method).toBe("POST");
    expect(start?.path).toBe("/connect-requests");
    expect(start?.body).toEqual({ client: "extension", extensionVersion: "0.1.0" });
    expect(start?.headers["knowtarium-protocol-version"]).toBe("2");
    expect(start?.headers["knowtarium-request"]).toBe("1");
    expect(start?.headers["authorization"]).toBeUndefined();

    // the code comes first, over the key and the request ID, then the web app's page opens
    const [first] = setup.events;
    expect(first?.step).toBe("code");
    const url = new URL(setup.opened[0] ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${APP}/connect/extension`);
    const requestId = url.searchParams.get("request") ?? "";
    const fragment = new URLSearchParams(url.hash.slice(1));
    const signPublicKey = fromBase64Url(fragment.get("signPublicKey") ?? "");
    expect(fromBase64Url(fragment.get("secret") ?? "")).toHaveLength(32);
    expect(first?.step === "code" && first.code).toBe(
      extensionConfirmationCode(signPublicKey, requestId),
    );
    expect(first?.step === "code" && first.connectUrl).toBe(setup.opened[0]);

    const { connection, categories, queue } = setup.store.snapshot();
    expect(connection?.workspaceId).toBe(setup.owner.workspaceId);
    expect(connection?.accountId).toBe(setup.owner.accountId);
    expect(connection?.workspaceName).toBe("Research");
    expect(connection?.apiOrigin).toBe(ORIGIN);
    expect(connection?.token.startsWith("kte_")).toBe(true);
    expect(setup.api.tokens.has(connection?.token ?? "")).toBe(true);
    expect(connection?.ownerSigningPublicKey).toBe(toBase64Url(setup.owner.signing.publicKey));
    expect(fromBase64Url(connection?.signPublicKey ?? "")).toEqual(signPublicKey);
    expect(fromBase64Url(connection?.signSecretKey ?? "")).toHaveLength(64);
    expect(connection?.inboxKey.envelope.revision).toBe(1);
    expect(connection?.inboxKey.envelope.generation).toBe(1);
    expect(categories).toEqual(["Reading", "Work"]);
    expect(queue).toEqual([]);
  });

  it("refuses a swapped inbox key and stores nothing", async () => {
    const attacker = createAccountKeys();
    const swapped = deriveInboxKeyPair(createWorkspaceKey());
    setup = makeSetup(() => ({
      inboxKey: setup.owner.inboxKey(1, { signer: attacker.signing, publicKey: swapped.publicKey }),
    }));
    expect(await run()).toEqual({ ok: false, reason: "bad_signature" });
    expect(setup.store.snapshot()).toEqual({});
  });

  it("refuses an inbox key the owner signed for another workspace", async () => {
    setup = makeSetup(() => ({
      inboxKey: setup.owner.inboxKey(1, { workspaceId: "ws_0000000000000000000000000a" }),
    }));
    expect(await run()).toEqual({ ok: false, reason: "bad_signature" });
    expect(setup.store.snapshot()).toEqual({});
  });

  it("refuses a payload whose extension_key names another key", async () => {
    const other = createExtensionKeys();
    setup = makeSetup(() => ({
      extensionId: "ext_0000000000000000000000000b",
      extensionKey: setup.owner.extensionKey("ext_0000000000000000000000000b", other.publicKey),
    }));
    expect(await run()).toEqual({ ok: false, reason: "wrong_key" });
    expect(setup.store.snapshot()).toEqual({});
  });

  it("refuses an extension_key for another extension ID", async () => {
    setup = makeSetup((link) => ({
      extensionId: "ext_0000000000000000000000000c",
      extensionKey: setup.owner.extensionKey("ext_0000000000000000000000000d", link.signPublicKey),
    }));
    expect(await run()).toEqual({ ok: false, reason: "wrong_key" });
    expect(setup.store.snapshot()).toEqual({});
  });

  it("refuses an extension_key the owner didn't sign", async () => {
    const attacker = createAccountKeys();
    setup = makeSetup((link) => ({
      extensionId: "ext_0000000000000000000000000e",
      extensionKey: setup.owner.extensionKey("ext_0000000000000000000000000e", link.signPublicKey, {
        signer: attacker.signing,
      }),
    }));
    expect(await run()).toEqual({ ok: false, reason: "wrong_key" });
  });

  it("refuses a payload sealed under another secret", async () => {
    setup = makeSetup(() => "nothing");
    const relayUnderWrongSecret = (url: string) => {
      const page = new URL(url);
      const requestId = page.searchParams.get("request") ?? "";
      const fragment = new URLSearchParams(page.hash.slice(1));
      const signPublicKey = fromBase64Url(fragment.get("signPublicKey") ?? "");
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const entry = setup.api.connect.get(requestId);
      if (entry !== undefined) {
        entry.status = "relayed";
        entry.relay = pairingPayload(setup.owner, { secret, signPublicKey }).relayed;
      }
      return Promise.resolve();
    };
    setup.deps = { ...setup.deps, openTab: relayUnderWrongSecret };
    expect(await run()).toEqual({ ok: false, reason: "bad_payload" });
    expect(setup.store.snapshot()).toEqual({});
  });

  it("keeps polling through network errors and 5xx answers", async () => {
    let polls = 0;
    setup = makeSetup();
    setup.api.override = (request) => {
      if (!request.path.endsWith("/poll")) return undefined;
      polls += 1;
      if (polls === 1) return apiError(503, "unavailable");
      if (polls === 2) throw new TypeError("Failed to fetch");
      if (polls === 3) return json(200, { status: "approved", pollIntervalSeconds: 1 });
      return undefined;
    };
    const result = await run();
    expect(result.ok).toBe(true);
    expect(polls).toBe(4);
    expect(setup.events.map((event) => event.step)).toEqual(["code", "approved"]);
  });

  it("says why when it stops", async () => {
    const cases: [WebApp | null, ((s: Setup) => void) | null, string][] = [
      [() => "deny", null, "denied"],
      [() => "expire", null, "expired"],
      [
        null,
        (s) => {
          s.api.offline = true;
        },
        "offline",
      ],
      [
        null,
        (s) => {
          s.api.override = (r) =>
            r.path === "/connect-requests" ? apiError(404, "not_found") : undefined;
        },
        "not_updated",
      ],
      [
        null,
        (s) => {
          s.api.override = (r) =>
            r.path === "/connect-requests" ? apiError(400, "invalid_request") : undefined;
        },
        "not_updated",
      ],
      [
        null,
        (s) => {
          s.api.override = (r) =>
            r.path === "/connect-requests"
              ? apiError(429, "rate_limited", {}, { "Retry-After": "60" })
              : undefined;
        },
        "rate_limited",
      ],
      [
        null,
        (s) => {
          s.api.override = (r) =>
            r.path === "/connect-requests" ? apiError(500, "internal") : undefined;
        },
        "server_error",
      ],
      [
        null,
        (s) => {
          s.api.override = (r) =>
            r.path.endsWith("/poll") ? json(200, { status: "completed" }) : undefined;
        },
        "used",
      ],
      [
        null,
        (s) => {
          s.api.override = (r) => (r.path.endsWith("/poll") ? apiError(410, "expired") : undefined);
        },
        "expired",
      ],
    ];
    for (const [webApp, tweak, reason] of cases) {
      const s = makeSetup(webApp ?? (() => "nothing"));
      tweak?.(s);
      expect(await run(s)).toEqual({ ok: false, reason });
      expect(s.store.snapshot()).toEqual({});
    }
  });

  it("gives up once the request has expired", async () => {
    setup = makeSetup(() => "nothing");
    let clock = Date.now();
    setup.deps = {
      ...setup.deps,
      now: () => clock,
      sleep: () => {
        clock += 60_000;
        return Promise.resolve();
      },
    };
    expect(await run()).toEqual({ ok: false, reason: "expired" });
  });

  it("connecting again keeps the queue (signed again as the new extension) and revokes the old token", async () => {
    const first = await run();
    expect(first.ok).toBe(true);
    const before = setup.store.snapshot();
    const oldToken = before.connection?.token ?? "";
    await setup.store.set({
      categories: [...(before.categories ?? []), "Later"],
      queue: [
        {
          clipId: "clip_0000000000000000000000000f",
          payload: {
            v: 1,
            clipId: "clip_0000000000000000000000000f",
            workspaceId: before.connection?.workspaceId ?? "",
            extensionId: before.connection?.extensionId ?? "",
            url: "https://example.com/",
            title: "Example",
            note: "",
            category: "",
            savedAt: "2026-10-10T09:41:07.512Z",
          },
          blob: "AQ",
          generation: 1,
          queuedAt: "2026-10-10T09:41:07.512Z",
        },
      ],
    });
    // the same owner and workspace, a new pairing
    const second = makeSetup(() => ({ categories: ["reading", "Ideas"] }), {
      api: setup.api,
      owner: setup.owner,
      store: setup.store,
    });
    expect(await run(second)).toMatchObject({ ok: true, kept: 1, discarded: 0 });
    const after = setup.store.snapshot();
    expect(after.connection?.token).not.toBe(oldToken);
    expect(setup.api.revoked.has(oldToken)).toBe(true);
    // the same workspace keeps the names added here; the payload's come first
    expect(after.categories).toEqual(["reading", "Ideas", "Work", "Later"]);
    const [item] = after.queue ?? [];
    expect(item?.payload.extensionId).toBe(after.connection?.extensionId);
    expect(item?.blob).not.toBe("AQ");
    const opened = setup.owner.openClip(
      fromBase64Url(item?.blob ?? ""),
      fromBase64Url(after.connection?.signPublicKey ?? ""),
    );
    expect(opened?.signed).toBe(true);
    expect(opened?.payload["clipId"]).toBe("clip_0000000000000000000000000f");
  });

  it("drops queued clips when the new connection is for another workspace", async () => {
    expect((await run()).ok).toBe(true);
    await setup.store.set({ queue: [queuedFor(setup.store.snapshot())] });
    // another owner: another account and workspace
    const other = makeSetup(() => ({ categories: ["Theirs"] }), {
      api: setup.api,
      store: setup.store,
    });
    expect(await run(other)).toMatchObject({
      ok: true,
      kept: 0,
      discarded: 1,
      discardedFrom: "Research",
    });
    const after = setup.store.snapshot();
    expect(after.queue).toEqual([]);
    expect(after.categories).toEqual(["Theirs"]);
    expect(after.connection?.workspaceId).toBe(other.owner.workspaceId);
  });

  it("after a 401, connecting again to the same workspace keeps the queue and categories", async () => {
    expect((await run()).ok).toBe(true);
    const paired = setup.store.snapshot();
    const { accountId, workspaceId, workspaceName } = paired.connection ?? {
      accountId: "",
      workspaceId: "",
      workspaceName: "",
    };
    // what a 401 leaves: no connection, the queue, the categories and the workspace they're for
    await setup.store.remove(["connection"]);
    await setup.store.set({
      notice: "disconnected",
      previousWorkspace: { accountId, workspaceId, workspaceName },
      categories: ["Reading", "Mine"],
      queue: [queuedFor(paired)],
    });
    const again = makeSetup(() => ({ categories: ["Reading"] }), {
      api: setup.api,
      owner: setup.owner,
      store: setup.store,
    });
    expect(await run(again)).toMatchObject({ ok: true, kept: 1, discarded: 0 });
    const after = setup.store.snapshot();
    expect(after.categories).toEqual(["Reading", "Mine"]);
    expect(after.queue?.[0]?.payload.extensionId).toBe(after.connection?.extensionId);
    expect(after.notice).toBeUndefined();
    expect(after.previousWorkspace).toBeUndefined();
  });
});

/** One queued clip for the stored connection's workspace. */
function queuedFor(state: StoredState): QueuedClip {
  const clipId = "clip_0000000000000000000000000g";
  return {
    clipId,
    payload: {
      v: 1,
      clipId,
      workspaceId: state.connection?.workspaceId ?? "",
      extensionId: state.connection?.extensionId ?? "",
      url: "https://example.com/",
      title: "Example",
      note: "",
      category: "",
      savedAt: "2026-10-10T09:41:07.512Z",
    },
    blob: "AQ",
    generation: 1,
    queuedAt: "2026-10-10T09:41:07.512Z",
  };
}

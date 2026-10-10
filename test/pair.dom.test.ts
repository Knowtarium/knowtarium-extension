import { createExtensionKeys, extensionConfirmationCode, fromBase64Url } from "knowtarium/clip";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApi } from "../src/lib/api";
import { localLock } from "../src/lib/lock";
import { memoryStore } from "../src/lib/storage";
import { mountPairPage, type PairPageDeps } from "../src/pair/view";
import pairHtml from "../src/pair.html?raw";
import { fakeApi, ORIGIN } from "./helpers/fake-api";
import { loadBody } from "./helpers/markup";
import {
  makeOwner,
  type Owner,
  pairingPayload,
  type PairingPayloadOptions,
  readyAll,
} from "./helpers/owner";

beforeAll(readyAll);

beforeEach(() => {
  loadBody(pairHtml);
});

const $ = (id: string) => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no #${id}`);
  return element;
};

type Options = (link: { signPublicKey: Uint8Array }, owner: Owner) => PairingPayloadOptions;

function setup(options: Options = () => ({})) {
  const api = fakeApi();
  const owner = makeOwner();
  const store = memoryStore();
  const seen: { code: string; requestId: string; signPublicKey: Uint8Array }[] = [];
  const deps: PairPageDeps = {
    api: createApi(ORIGIN, api.fetch),
    store,
    lock: localLock(),
    apiOrigin: ORIGIN,
    appOrigin: "https://app.test",
    extensionVersion: "0.1.0",
    openTab: (url) => {
      const page = new URL(url);
      const requestId = page.searchParams.get("request") ?? "";
      const fragment = new URLSearchParams(page.hash.slice(1));
      const link = {
        signPublicKey: fromBase64Url(fragment.get("signPublicKey") ?? ""),
        secret: fromBase64Url(fragment.get("secret") ?? ""),
      };
      // the code is on screen before the web app's page opens
      seen.push({
        code: $("code").textContent,
        requestId,
        signPublicKey: link.signPublicKey,
      });
      expect($("code-step").hidden).toBe(false);
      const payload = pairingPayload(owner, link, options(link, owner));
      api.tokens.add(payload.token);
      const entry = api.connect.get(requestId);
      if (entry !== undefined) {
        entry.status = "relayed";
        entry.relay = payload.relayed;
      }
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    shortcut: () => Promise.resolve("Alt+Shift+S"),
  };
  return { api, owner, store, deps, seen };
}

describe("the pairing page", () => {
  it("shows the code at once, then says it is connected", async () => {
    const s = setup();
    const result = await mountPairPage(document, s.deps).run();
    expect(result.ok).toBe(true);
    const [first] = s.seen;
    expect(first?.code).toBe(
      extensionConfirmationCode(first?.signPublicKey ?? new Uint8Array(), first?.requestId ?? ""),
    );
    expect(first?.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect($("done").hidden).toBe(false);
    expect($("done-text").textContent).toBe("Connected to Research");
    expect($("done-hint").textContent).toContain("Alt+Shift+S");
    expect(s.store.snapshot().connection?.workspaceName).toBe("Research");
  });

  it("says when the answer doesn't check out, and offers to start again", async () => {
    const other = createExtensionKeys();
    const id = "ext_0000000000000000000000000b";
    const s = setup((_link, owner) => ({
      extensionId: id,
      extensionKey: owner.extensionKey(id, other.publicKey),
    }));
    const result = await mountPairPage(document, s.deps).run();
    expect(result).toEqual({ ok: false, reason: "wrong_key" });
    expect($("failed").hidden).toBe(false);
    expect($("failed-text").textContent).toContain("didn't check out");
    expect(document.activeElement).toBe($("restart"));
    expect(s.store.snapshot()).toEqual({});
  });

  it("without the popup's nonce shows the state and starts nothing", async () => {
    const s = setup();
    await mountPairPage(document, s.deps).showIdle();
    expect($("idle").hidden).toBe(false);
    expect($("idle-text").textContent).toContain("Connect this browser");
    expect($("start").textContent).toBe("Connect to Knowtarium");
    expect(s.api.requests).toHaveLength(0);
    expect(s.seen).toHaveLength(0);
  });

  it("shows a restored tab as connected, with Connect again", async () => {
    const s = setup();
    const page = mountPairPage(document, s.deps);
    expect((await page.run()).ok).toBe(true);
    loadBody(pairHtml);
    const requests = s.api.requests.length;
    const restored = mountPairPage(document, s.deps);
    await restored.showIdle();
    expect($("idle-text").textContent).toBe("Connected to Research");
    expect($("start").textContent).toBe("Connect again");
    expect(s.api.requests).toHaveLength(requests);
    $("start").click();
    await vi.waitFor(() => {
      expect($("done").hidden).toBe(false);
    });
  });

  it("warns about clips waiting for another workspace and says how many were discarded", async () => {
    const s = setup();
    await s.store.set({
      previousWorkspace: {
        accountId: "acc_0000000000000000000000000a",
        workspaceId: "ws_0000000000000000000000000a",
        workspaceName: "Old notes",
      },
      queue: [
        {
          clipId: "clip_0000000000000000000000000h",
          payload: {
            v: 1,
            clipId: "clip_0000000000000000000000000h",
            workspaceId: "ws_0000000000000000000000000a",
            extensionId: "ext_0000000000000000000000000a",
            url: "https://example.com/",
            title: "",
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
    const page = mountPairPage(document, s.deps);
    await page.showIdle();
    expect($("discard-warning").textContent).toBe(
      "1 clip waiting for Old notes will be discarded if you connect to a different workspace.",
    );
    expect(await page.run()).toMatchObject({ ok: true, discarded: 1 });
    expect($("done-queue").textContent).toBe(
      "1 clip waiting for Old notes was discarded, since this is a different workspace.",
    );
    expect(s.store.snapshot().queue).toEqual([]);
  });
});

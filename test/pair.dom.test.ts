import { createExtensionKeys, extensionConfirmationCode, fromBase64Url } from "knowtarium/clip";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

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
});

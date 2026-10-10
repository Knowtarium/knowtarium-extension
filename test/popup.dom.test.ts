import { fromBase64Url, ready } from "knowtarium/clip";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TEXT, waitText } from "../src/lib/messages";
import type { CurrentPage } from "../src/lib/tab";
import { mountPopup, NEW_CATEGORY, type PopupDeps } from "../src/popup/view";
import popupHtml from "../src/popup.html?raw";
import { connected, PAGE } from "./helpers/connected";
import { ORIGIN } from "./helpers/fake-api";
import { loadBody } from "./helpers/markup";
import { readyAll } from "./helpers/owner";

beforeAll(readyAll);

beforeEach(() => {
  loadBody(popupHtml);
});

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no #${id}`);
  return element;
};
const input = (id: string) => $(id) as HTMLInputElement;
const textarea = (id: string) => $(id) as HTMLTextAreaElement;
const selectEl = (id: string) => $(id) as HTMLSelectElement;
const button = (id: string) => $(id) as HTMLButtonElement;
const form = (id: string) => $(id) as HTMLFormElement;

const visible = (id: string) => !$(id).hidden;

function mount(
  state: ReturnType<typeof connected>,
  page: CurrentPage = { ...PAGE, saveable: true },
  overrides: Partial<PopupDeps> = {},
) {
  const deps: PopupDeps = {
    clipper: state.clipper,
    store: state.store,
    apiOrigin: ORIGIN,
    ready,
    readPage: () => Promise.resolve(page),
    openPairing: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    autoCloseMs: 60_000,
    ...overrides,
  };
  return { deps, handle: mountPopup(document, deps) };
}

async function submit(): Promise<void> {
  form("clip-form").requestSubmit();
  await vi.waitFor(() => {
    expect($("save").textContent).toBe("Save");
  });
}

describe("the popup", () => {
  it("shows the page, the categories with Inbox first, and focuses Save", async () => {
    const state = connected({ categories: ["Work", "Reading"] });
    const { handle } = mount(state);
    await handle.loaded;
    expect(visible("clip-form")).toBe(true);
    expect(textarea("title").value).toBe(PAGE.title);
    expect(input("link").value).toBe(PAGE.url);
    expect(input("link").readOnly).toBe(true);
    const options = Array.from(selectEl("category").options).map((o) => o.text);
    expect(options).toEqual(["Inbox", "Inbox/Reading", "Inbox/Work", "+ New category"]);
    expect(selectEl("category").value).toBe("");
    expect(button("save").disabled).toBe(false);
    expect(document.activeElement).toBe($("save"));
    // the workspace's name is in the footer only
    expect($("popup").querySelector("header")?.textContent.trim()).toBe("Knowtarium");
    expect($("note-hint").textContent).toBe("Ctrl+Enter saves");
    expect($("connected-to").textContent).toBe("Connected to Research");
    expect($("popup").hasAttribute("aria-busy")).toBe(false);
    // every field has a label
    for (const id of ["title", "link", "note", "category", "new-category-name"]) {
      expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
  });

  it("saves with the edited title, the note and the category", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    textarea("title").value = "Faster builds";
    textarea("note").value = "Read before the CI meeting.";
    const picker = selectEl("category");
    picker.value = "Reading";
    picker.dispatchEvent(new Event("change"));
    await submit();
    expect(visible("done")).toBe(true);
    expect($("done-text").textContent).toBe("Saved to Inbox/Reading");
    expect(document.activeElement).toBe($("close"));
    const [blob] = state.api.clips.values();
    const opened = state.owner.openClip(
      Uint8Array.from(atob((blob ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ),
      state.signPublicKey,
    );
    expect(opened?.payload).toMatchObject({
      title: "Faster builds",
      note: "Read before the CI meeting.",
      category: "Reading",
      url: PAGE.url,
    });
  });

  it("adds a new category from the picker", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    const picker = selectEl("category");
    picker.value = NEW_CATEGORY;
    picker.dispatchEvent(new Event("change"));
    expect(visible("new-category")).toBe(true);
    expect(document.activeElement).toBe($("new-category-name"));

    input("new-category-name").value = "inbox";
    $("new-category-name").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => {
      expect(visible("new-category-error")).toBe(true);
    });
    expect($("new-category-name").getAttribute("aria-invalid")).toBe("true");

    input("new-category-name").value = "Ideas";
    $("new-category-name").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => {
      expect(visible("new-category")).toBe(false);
    });
    expect(picker.value).toBe("Ideas");
    expect(state.store.snapshot().categories).toEqual(["Reading", "Ideas"]);
    await submit();
    expect($("done-text").textContent).toBe("Saved to Inbox/Ideas");
  });

  it("cancels a new category with Escape", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    const picker = selectEl("category");
    picker.value = NEW_CATEGORY;
    picker.dispatchEvent(new Event("change"));
    $("new-category-name").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(visible("new-category")).toBe(false);
    expect(picker.value).toBe("");
  });

  it("says a page that isn't http or https can't be saved", async () => {
    const state = connected();
    const { handle } = mount(state, {
      url: "chrome://extensions",
      title: "Extensions",
      saveable: false,
    });
    await handle.loaded;
    expect(visible("clip-form")).toBe(false);
    expect(visible("cant-save")).toBe(true);
    expect($("cant-save").textContent).toContain(TEXT.cantSave);
  });

  it("queues a clip offline and says so", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    state.api.offline = true;
    await submit();
    expect($("done-text").textContent).toBe(waitText("offline"));
    expect($("waiting").textContent).toBe("1 clip waiting to be sent");
  });

  it("sends the queue when it opens", async () => {
    const state = connected();
    state.api.offline = true;
    await state.clipper.save({ ...PAGE, note: "", category: "" });
    state.api.offline = false;
    const { handle } = mount(state);
    await handle.loaded;
    expect(state.api.clips.size).toBe(1);
    expect(visible("waiting")).toBe(false);
  });

  it("points at the field that is too long", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    textarea("title").value = "x".repeat(301);
    await submit();
    expect($("alert").textContent).toBe(TEXT.titleTooLong);
    expect($("title").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe($("title"));
    expect(visible("clip-form")).toBe(true);
  });

  it("keeps the clip when the storage is full, and says so", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    state.api.override = (r) =>
      r.path === "/extensions/current/clips"
        ? new Response('{"error":{"code":"quota_exceeded","message":"x"}}', { status: 402 })
        : undefined;
    await submit();
    expect($("done-text").textContent).toBe(
      "Your Knowtarium storage is full. This clip waits here.",
    );
    expect($("waiting").textContent).toBe("1 clip waiting to be sent");
  });

  it("shows the API's refusals and keeps the form", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    state.api.override = (r) =>
      r.path === "/extensions/current/clips"
        ? new Response('{"error":{"code":"invalid_request","message":"x"}}', { status: 400 })
        : undefined;
    await submit();
    expect($("alert").textContent).toBe("Knowtarium refused this clip");
    expect(visible("clip-form")).toBe(true);
  });

  it("says when a rate-limited clip will be sent", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    state.api.override = (r) =>
      r.path === "/extensions/current/clips"
        ? new Response('{"error":{"code":"rate_limited","message":"x"}}', {
            status: 429,
            headers: { "Retry-After": "300" },
          })
        : undefined;
    await submit();
    expect($("done-text").textContent).toBe(
      waitText("rate_limited", { retryAt: state.clock + 300_000 }),
    );
  });

  it("offers Connect when not connected, and Connect again after the server ended it", async () => {
    const state = connected();
    await state.store.remove(["connection"]);
    const { handle, deps } = mount(state);
    await handle.loaded;
    expect(visible("connect")).toBe(true);
    expect($("connect-button").textContent.trim()).toBe("Connect to Knowtarium");
    $("connect-button").click();
    expect(deps.openPairing).toHaveBeenCalled();

    await state.store.set({ notice: "disconnected" });
    loadBody(popupHtml);
    const second = mount(state);
    await second.handle.loaded;
    expect($("alert").textContent).toBe("Disconnected from Knowtarium");
    expect($("connect-button").textContent).toBe("Connect again");
  });

  it("switches to Connect again when a save finds the token revoked", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    state.api.revoked.add(state.connection.token);
    await submit();
    expect(visible("connect")).toBe(true);
    expect($("alert").textContent).toBe("Disconnected from Knowtarium");
  });

  it("disconnects after a confirmation", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    $("disconnect").click();
    await vi.waitFor(() => {
      expect(visible("confirm-disconnect")).toBe(true);
    });
    expect($("confirm-text").textContent).toBe("Disconnect from Research?");
    expect(document.activeElement).toBe($("confirm-no"));
    $("confirm-yes").click();
    await vi.waitFor(() => {
      expect(visible("connect")).toBe(true);
    });
    expect(state.store.snapshot()).toEqual({});
    expect(state.api.revoked.has(state.connection.token)).toBe(true);
  });

  it("names the waiting clips in the Disconnect confirmation", async () => {
    const state = connected();
    state.api.offline = true;
    await state.clipper.save({ ...PAGE, note: "", category: "" });
    await state.clipper.save({ ...PAGE, note: "", category: "" });
    const { handle } = mount(state);
    await handle.loaded;
    $("disconnect").click();
    await vi.waitFor(() => {
      expect($("confirm-text").textContent).toBe(
        "Disconnect from Research? The 2 clips waiting to be sent will be removed.",
      );
    });
  });

  it("saves on Enter in the title, which keeps to one line", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    textarea("title").value = "Line one\nline two";
    textarea("title").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
    );
    await vi.waitFor(() => {
      expect(visible("done")).toBe(true);
    });
    const [blob] = state.api.clips.values();
    const opened = state.owner.openClip(fromBase64Url(blob ?? ""), state.signPublicKey);
    expect(opened?.payload["title"]).toBe("Line one line two");
  });

  it("closes itself shortly after Saved, unless the person moves on", async () => {
    const quiet = connected();
    const first = mount(quiet, undefined, { autoCloseMs: 20 });
    await first.handle.loaded;
    await submit();
    await vi.waitFor(() => {
      expect(first.deps.close).toHaveBeenCalled();
    });

    loadBody(popupHtml);
    const busy = connected();
    const second = mount(busy, undefined, { autoCloseMs: 50 });
    await second.handle.loaded;
    await submit();
    document.dispatchEvent(new Event("pointermove"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(second.deps.close).not.toHaveBeenCalled();
  });

  it("doesn't close itself when the clip only waits", async () => {
    const state = connected();
    const { handle, deps } = mount(state, undefined, { autoCloseMs: 10 });
    await handle.loaded;
    state.api.offline = true;
    await submit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.close).not.toHaveBeenCalled();
  });

  it("offers Connect again when the inbox key in an answer doesn't verify", async () => {
    const state = connected();
    const { handle } = mount(state);
    await handle.loaded;
    state.api.override = (r) =>
      r.path === "/extensions/current/clips"
        ? new Response(
            JSON.stringify({
              error: { code: "stale_inbox_key", message: "", inboxKey: { envelope: {} } },
            }),
            { status: 409 },
          )
        : undefined;
    await submit();
    expect($("done-text").textContent).toBe(waitText("unverified_key"));
    expect(visible("reconnect-row")).toBe(true);
  });

  it("warns before connecting when clips wait for a workspace", async () => {
    const state = connected();
    state.api.offline = true;
    await state.clipper.save({ ...PAGE, note: "", category: "" });
    state.api.offline = false;
    state.api.revoked.add(state.connection.token);
    const { handle } = mount(state);
    await handle.loaded;
    await vi.waitFor(() => {
      expect($("connect-warning").textContent).toBe(
        "1 clip waiting for Research will be discarded if you connect to a different workspace.",
      );
    });
    expect(visible("connect-warning")).toBe(true);
  });
});

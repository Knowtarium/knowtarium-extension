import { addCategory, sortCategories } from "../lib/categories";
import type { Clipper, SaveResult } from "../lib/clipper";
import {
  discardWarning,
  flushMessage,
  type Message,
  saveMessage,
  TEXT,
  waitingText,
} from "../lib/messages";
import { queueWorkspace, readConnection, type StateStore } from "../lib/storage";
import type { CurrentPage } from "../lib/tab";

// The popup: the current page's title (editable) and link, an optional note, a category (Inbox by
// default, the stored names, "+ New category") and Save. Saving takes two clicks: the toolbar
// button (or Alt+Shift+S), then Save, which has the focus when the popup opens. Every text is set
// with textContent; nothing from a page, the person or the server is ever parsed as HTML.

/** The value of the picker's last option, which opens the new category field. */
export const NEW_CATEGORY = "\u0000new";

export interface PopupDeps {
  readonly clipper: Clipper;
  readonly store: StateStore;
  readonly apiOrigin: string;
  /** Loads libsodium; Save stays disabled until it has. */
  readonly ready: () => Promise<void>;
  readonly readPage: () => Promise<CurrentPage>;
  /** Opens pair.html in a tab with a one-time start nonce (and closes the popup). */
  readonly openPairing: () => Promise<void>;
  readonly close: () => void;
  /** How long "Saved to ..." stays before the popup closes, unless the person moves on. */
  readonly autoCloseMs?: number;
  /** Whether the keyboard has Cmd rather than Ctrl, for the note's hint. */
  readonly mac?: boolean;
}

/** The default for `autoCloseMs`. */
export const AUTO_CLOSE_MS = 1500;

function byId(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (element === null) throw new Error(`popup.html has no #${id}`);
  return element;
}

export interface PopupHandle {
  /** Settles once the popup has loaded and sent its queue (for tests). */
  readonly loaded: Promise<void>;
}

export function mountPopup(doc: Document, deps: PopupDeps): PopupHandle {
  const el = {
    popup: byId(doc, "popup"),
    loading: byId(doc, "loading"),
    connect: byId(doc, "connect"),
    connectWarning: byId(doc, "connect-warning"),
    connectButton: byId(doc, "connect-button") as HTMLButtonElement,
    form: byId(doc, "clip-form") as HTMLFormElement,
    title: byId(doc, "title") as HTMLTextAreaElement,
    link: byId(doc, "link") as HTMLInputElement,
    noteHint: byId(doc, "note-hint"),
    note: byId(doc, "note") as HTMLTextAreaElement,
    category: byId(doc, "category") as HTMLSelectElement,
    newCategory: byId(doc, "new-category"),
    newCategoryName: byId(doc, "new-category-name") as HTMLInputElement,
    addCategory: byId(doc, "add-category") as HTMLButtonElement,
    newCategoryError: byId(doc, "new-category-error"),
    save: byId(doc, "save") as HTMLButtonElement,
    cantSave: byId(doc, "cant-save"),
    done: byId(doc, "done"),
    doneText: byId(doc, "done-text"),
    close: byId(doc, "close") as HTMLButtonElement,
    status: byId(doc, "status"),
    alert: byId(doc, "alert"),
    reconnectRow: byId(doc, "reconnect-row"),
    reconnect: byId(doc, "reconnect") as HTMLButtonElement,
    waiting: byId(doc, "waiting"),
    confirm: byId(doc, "confirm-disconnect"),
    confirmText: byId(doc, "confirm-text"),
    confirmYes: byId(doc, "confirm-yes") as HTMLButtonElement,
    confirmNo: byId(doc, "confirm-no") as HTMLButtonElement,
    footer: byId(doc, "footer"),
    connectedTo: byId(doc, "connected-to"),
    disconnect: byId(doc, "disconnect") as HTMLButtonElement,
  };

  let page: CurrentPage = { url: "", title: "", saveable: false };
  let categories: string[] = [];
  let selected = "";
  let saving = false;
  let workspaceName = "";

  const sections = [el.loading, el.connect, el.form, el.cantSave, el.done];
  function showOnly(section: HTMLElement | null): void {
    for (const candidate of sections) candidate.hidden = candidate !== section;
  }

  function clearMessages(): void {
    el.status.hidden = true;
    el.status.textContent = "";
    el.alert.hidden = true;
    el.alert.textContent = "";
    el.reconnectRow.hidden = true;
  }

  function showMessage(message: Message | null): void {
    clearMessages();
    if (message === null) return;
    const target = message.tone === "error" ? el.alert : el.status;
    target.textContent = message.text;
    target.className = `message message-${message.tone}`;
    target.hidden = false;
    el.reconnectRow.hidden = message.reconnect !== true;
  }

  async function updateWaiting(): Promise<void> {
    const text = waitingText(await deps.clipper.waiting());
    el.waiting.textContent = text ?? "";
    el.waiting.hidden = text === null;
  }

  function renderCategories(): void {
    const options = [
      { value: "", label: "Inbox" },
      ...sortCategories(categories).map((name) => ({ value: name, label: `Inbox/${name}` })),
      { value: NEW_CATEGORY, label: "+ New category" },
    ];
    el.category.replaceChildren(
      ...options.map(({ value, label }) => {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    el.category.value = selected;
  }

  function closeNewCategory(): void {
    el.newCategory.hidden = true;
    el.newCategoryName.value = "";
    el.newCategoryName.removeAttribute("aria-invalid");
    el.newCategoryError.hidden = true;
    el.newCategoryError.textContent = "";
  }

  async function addTypedCategory(): Promise<void> {
    const added = addCategory(categories, el.newCategoryName.value);
    if (!added.ok) {
      el.newCategoryError.textContent =
        added.reason === "full"
          ? "There are too many categories already."
          : 'Type a name other than "Inbox".';
      el.newCategoryError.hidden = false;
      el.newCategoryName.setAttribute("aria-invalid", "true");
      el.newCategoryName.focus();
      return;
    }
    categories = added.categories;
    selected = added.name;
    await deps.store.set({ categories });
    closeNewCategory();
    renderCategories();
    el.category.focus();
  }

  function markInvalid(field: "url" | "title" | "note" | null): void {
    el.title.removeAttribute("aria-invalid");
    el.note.removeAttribute("aria-invalid");
    if (field === "title") {
      el.title.setAttribute("aria-invalid", "true");
      el.title.focus();
    } else if (field === "note") {
      el.note.setAttribute("aria-invalid", "true");
      el.note.focus();
    }
  }

  /** The title grows with its text (two rows at least). */
  function fitTitle(): void {
    el.title.style.height = "auto";
    el.title.style.height = `${String(el.title.scrollHeight + 2)}px`;
  }

  /** Before connecting: clips waiting for a workspace are dropped if another one is picked. */
  async function showConnectWarning(): Promise<void> {
    const owner = await queueWorkspace(deps.store, deps.apiOrigin);
    const text =
      owner === undefined
        ? null
        : discardWarning(await deps.clipper.waiting(), owner.workspaceName);
    el.connectWarning.textContent = text ?? "";
    el.connectWarning.hidden = text === null;
  }

  function showConnect(message: Message | null): void {
    el.footer.hidden = true;
    el.confirm.hidden = true;
    el.waiting.hidden = true;
    showOnly(el.connect);
    showMessage(message === null ? null : { ...message, reconnect: false });
    el.connectButton.textContent =
      message?.reconnect === true ? "Connect again" : "Connect to Knowtarium";
    el.connectButton.focus();
    void showConnectWarning().catch(() => undefined);
  }

  function setSaving(value: boolean): void {
    saving = value;
    if (value) el.save.setAttribute("aria-disabled", "true");
    else el.save.removeAttribute("aria-disabled");
    el.save.textContent = value ? "Saving" : "Save";
  }

  async function onSaved(result: SaveResult): Promise<void> {
    const message = saveMessage(result);
    if (result.kind === "disconnected") {
      showConnect(message);
      return;
    }
    if (result.kind === "saved" || result.kind === "queued") {
      showOnly(el.done);
      clearMessages();
      el.doneText.textContent = message.text;
      el.doneText.className = `message message-${message.tone}`;
      el.reconnectRow.hidden = message.reconnect !== true;
      await updateWaiting();
      // the Close button is described by the outcome, so focusing it reads the outcome out
      el.close.focus();
      if (result.kind === "saved") closeSoon();
      return;
    }
    showMessage(message);
    if (result.kind === "invalid") markInvalid(result.field);
    else el.save.focus();
  }

  /** Closes the popup after "Saved to ...", unless the person points, clicks or types first. */
  function closeSoon(): void {
    const events = ["pointermove", "pointerdown", "keydown", "focusin"] as const;
    const cancel = () => {
      clearTimeout(timer);
      for (const name of events) doc.removeEventListener(name, cancel, true);
    };
    const timer = setTimeout(() => {
      cancel();
      deps.close();
    }, deps.autoCloseMs ?? AUTO_CLOSE_MS);
    for (const name of events) doc.addEventListener(name, cancel, true);
  }

  async function save(): Promise<void> {
    if (saving || el.save.disabled) return;
    setSaving(true);
    clearMessages();
    markInvalid(null);
    try {
      const result = await deps.clipper.save({
        url: page.url,
        // a pasted title may hold line breaks: they become spaces
        title: el.title.value.replace(/[\r\n]+/g, " "),
        note: el.note.value,
        category: selected,
      });
      await onSaved(result);
    } catch {
      showMessage({ tone: "error", text: TEXT.invalid });
    } finally {
      setSaving(false);
    }
  }

  // events
  el.connectButton.addEventListener("click", () => void deps.openPairing());
  el.reconnect.addEventListener("click", () => void deps.openPairing());
  el.close.addEventListener("click", () => {
    deps.close();
  });
  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  el.title.addEventListener("keydown", (event) => {
    // a title is one line: Enter saves
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void save();
    }
  });
  el.title.addEventListener("input", fitTitle);
  el.note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  });
  el.category.addEventListener("change", () => {
    if (el.category.value === NEW_CATEGORY) {
      el.newCategory.hidden = false;
      el.newCategoryName.focus();
      return;
    }
    selected = el.category.value;
    closeNewCategory();
  });
  el.newCategoryName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addTypedCategory();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeNewCategory();
      el.category.value = selected;
      el.category.focus();
    }
  });
  el.addCategory.addEventListener("click", () => void addTypedCategory());
  el.disconnect.addEventListener("click", () => {
    void (async () => {
      const count = await deps.clipper.waiting();
      const clips = count === 1 ? "The clip" : `The ${String(count)} clips`;
      el.confirmText.textContent =
        count === 0
          ? `Disconnect from ${workspaceName}?`
          : `Disconnect from ${workspaceName}? ${clips} waiting to be sent will be removed.`;
      el.confirm.hidden = false;
      el.confirmNo.focus();
    })();
  });
  el.confirmNo.addEventListener("click", () => {
    el.confirm.hidden = true;
    el.disconnect.focus();
  });
  el.confirmYes.addEventListener("click", () => {
    void (async () => {
      el.confirmYes.setAttribute("aria-disabled", "true");
      const { revoked } = await deps.clipper.disconnect();
      el.confirmYes.removeAttribute("aria-disabled");
      showConnect({
        tone: "info",
        text: revoked
          ? "Disconnected. This browser can't save to Knowtarium anymore."
          : "Disconnected here, but Knowtarium couldn't be reached. Remove this extension in your workspace's settings too.",
      });
    })();
  });

  async function load(): Promise<void> {
    const connection = await readConnection(deps.store, deps.apiOrigin);
    if (connection === undefined) {
      const { notice } = await deps.store.get(["notice"]);
      showConnect(notice === "disconnected" ? saveMessage({ kind: "disconnected" }) : null);
      return;
    }
    workspaceName = connection.workspaceName;
    el.noteHint.textContent = deps.mac === true ? "Cmd+Enter saves" : "Ctrl+Enter saves";
    el.connectedTo.textContent = `Connected to ${workspaceName}`;
    el.footer.hidden = false;
    const [stored, current] = await Promise.all([deps.store.get(["categories"]), deps.readPage()]);
    categories = [...(stored.categories ?? [])];
    page = current;
    if (!page.saveable) {
      showOnly(el.cantSave);
    } else {
      el.title.value = page.title;
      el.link.value = page.url;
      el.link.title = page.url;
      renderCategories();
      showOnly(el.form);
      fitTitle();
      await deps.ready();
      el.save.disabled = false;
      el.save.focus();
    }
    await updateWaiting();
    await sendWaiting();
  }

  /** Sends what waits and reads the inbox key once a day; the form stays usable meanwhile. */
  async function sendWaiting(): Promise<void> {
    try {
      const flushed = await deps.clipper.flush();
      const refreshed = await deps.clipper.refreshInboxKey();
      if (flushed.stoppedBy === "disconnected" || refreshed === "disconnected") {
        if (el.done.hidden) showConnect(saveMessage({ kind: "disconnected" }));
        return;
      }
      if (el.done.hidden && !saving) showMessage(flushMessage(flushed));
      await updateWaiting();
    } catch {
      // the next popup tries again
    }
  }

  const loaded = load()
    .catch(() => {
      showOnly(null);
      showMessage({ tone: "error", text: "Something went wrong. Close this popup and try again." });
    })
    .finally(() => {
      el.popup.removeAttribute("aria-busy");
    });
  return { loaded };
}

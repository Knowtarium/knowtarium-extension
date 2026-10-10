import { discardedText, discardWarning, keptText, pairingFailureText } from "../lib/messages";
import { pair, type PairingDeps, type PairingResult } from "../lib/pairing";
import { queueWorkspace, readConnection } from "../lib/storage";

// pair.html. Opened by the popup's Connect button (with its one-time nonce) it starts pairing at
// once: it shows the code, waits for the web app's answer and says how it ended. Opened any
// other way (a tab the browser restored, a reload) it starts nothing and shows the current
// state, with a button to connect. Texts are set with textContent only.

export interface PairPageDeps extends PairingDeps {
  /** The shortcut that opens the popup, as Chrome shows it, or "" when there is none. */
  readonly shortcut: () => Promise<string>;
}

function byId(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (element === null) throw new Error(`pair.html has no #${id}`);
  return element;
}

export interface PairPage {
  /** Starts pairing now. */
  readonly run: () => Promise<PairingResult>;
  /** Shows the current state without starting anything. */
  readonly showIdle: () => Promise<void>;
}

export function mountPairPage(doc: Document, deps: PairPageDeps): PairPage {
  const el = {
    page: byId(doc, "page"),
    starting: byId(doc, "starting"),
    idle: byId(doc, "idle"),
    idleText: byId(doc, "idle-text"),
    start: byId(doc, "start") as HTMLButtonElement,
    warning: byId(doc, "discard-warning"),
    codeStep: byId(doc, "code-step"),
    code: byId(doc, "code"),
    status: byId(doc, "pair-status"),
    reopen: byId(doc, "reopen") as HTMLButtonElement,
    done: byId(doc, "done"),
    doneText: byId(doc, "done-text"),
    doneQueue: byId(doc, "done-queue"),
    doneHint: byId(doc, "done-hint"),
    failed: byId(doc, "failed"),
    failedText: byId(doc, "failed-text"),
    restart: byId(doc, "restart") as HTMLButtonElement,
  };
  let url = "";
  let running = false;

  function show(section: HTMLElement): void {
    for (const candidate of [el.starting, el.idle, el.codeStep, el.done, el.failed]) {
      candidate.hidden = candidate !== section;
    }
  }

  function setText(element: HTMLElement, text: string | null): void {
    element.textContent = text ?? "";
    element.hidden = text === null;
  }

  /** The warning about clips waiting for the workspace this extension was connected to. */
  async function showWarning(): Promise<void> {
    const owner = await queueWorkspace(deps.store, deps.apiOrigin);
    const { queue } = await deps.store.get(["queue"]);
    setText(
      el.warning,
      owner === undefined ? null : discardWarning(queue?.length ?? 0, owner.workspaceName),
    );
  }

  async function showIdle(): Promise<void> {
    const connection = await readConnection(deps.store, deps.apiOrigin);
    el.idleText.textContent =
      connection === undefined
        ? "Connect this browser to one Knowtarium workspace to save pages to its inbox."
        : `Connected to ${connection.workspaceName}`;
    el.start.textContent = connection === undefined ? "Connect to Knowtarium" : "Connect again";
    await showWarning();
    show(el.idle);
    el.page.removeAttribute("aria-busy");
  }

  async function run(): Promise<PairingResult> {
    running = true;
    show(el.starting);
    el.page.setAttribute("aria-busy", "true");
    await showWarning().catch(() => undefined);
    let result: PairingResult;
    try {
      result = await pair(deps, (event) => {
        if (event.step === "code") {
          url = event.connectUrl;
          el.code.textContent = event.code;
          el.code.setAttribute("aria-label", `Code ${event.code.split("").join(" ")}`);
          el.status.textContent = "Waiting for you to allow it in Knowtarium";
          show(el.codeStep);
          el.page.removeAttribute("aria-busy");
        } else {
          el.status.textContent = "Allowed. Finishing";
        }
      });
    } catch {
      result = { ok: false, reason: "server_error" };
    }
    running = false;
    el.page.removeAttribute("aria-busy");
    if (result.ok) {
      el.warning.hidden = true;
      el.doneText.textContent = `Connected to ${result.workspaceName}`;
      setText(
        el.doneQueue,
        discardedText(result.discarded, result.discardedFrom) ?? keptText(result.kept),
      );
      const shortcut = await deps.shortcut().catch(() => "");
      el.doneHint.textContent =
        shortcut === ""
          ? "You can close this tab. To save a page, click the Knowtarium button in the toolbar."
          : `You can close this tab. To save a page, click the Knowtarium button in the toolbar or press ${shortcut}.`;
      show(el.done);
    } else {
      el.failedText.textContent = pairingFailureText(result.reason);
      show(el.failed);
      el.restart.focus();
    }
    return result;
  }

  el.reopen.addEventListener("click", () => {
    if (url !== "") void deps.openTab(url);
  });
  for (const button of [el.restart, el.start]) {
    button.addEventListener("click", () => {
      if (!running) void run();
    });
  }
  return { run, showIdle };
}

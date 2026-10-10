import { pairingFailureText } from "../lib/messages";
import type { PairingDeps, PairingResult } from "../lib/pairing";
import { pair } from "../lib/pairing";

// pair.html: starts pairing as soon as it opens (the person clicked "Connect to Knowtarium"), shows
// the code at once, waits for the web app's answer and says how it ended. Texts are set with
// textContent only.

export interface PairPageDeps extends PairingDeps {
  /** The shortcut that opens the popup, as Chrome shows it, or "" when there is none. */
  readonly shortcut: () => Promise<string>;
}

function byId(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (element === null) throw new Error(`pair.html has no #${id}`);
  return element;
}

export function mountPairPage(
  doc: Document,
  deps: PairPageDeps,
): { run: () => Promise<PairingResult> } {
  const el = {
    page: byId(doc, "page"),
    starting: byId(doc, "starting"),
    codeStep: byId(doc, "code-step"),
    code: byId(doc, "code"),
    status: byId(doc, "pair-status"),
    reopen: byId(doc, "reopen") as HTMLButtonElement,
    done: byId(doc, "done"),
    doneText: byId(doc, "done-text"),
    doneHint: byId(doc, "done-hint"),
    failed: byId(doc, "failed"),
    failedText: byId(doc, "failed-text"),
    restart: byId(doc, "restart") as HTMLButtonElement,
  };
  let url = "";
  let running = false;

  function show(section: HTMLElement): void {
    for (const candidate of [el.starting, el.codeStep, el.done, el.failed]) {
      candidate.hidden = candidate !== section;
    }
  }

  async function run(): Promise<PairingResult> {
    running = true;
    show(el.starting);
    el.page.setAttribute("aria-busy", "true");
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
      el.doneText.textContent = `Connected to ${result.workspaceName}`;
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
  el.restart.addEventListener("click", () => {
    if (!running) void run();
  });
  return { run };
}

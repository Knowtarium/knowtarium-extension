// The page to save: the active tab of the current window, read when the popup opens. `activeTab`
// grants its link and title for that moment only; no other tab is ever read.

export interface CurrentPage {
  readonly url: string;
  readonly title: string;
  /** Only `http:` and `https:` pages can be saved. */
  readonly saveable: boolean;
}

export function isSaveableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function readCurrentPage(): Promise<CurrentPage> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";
  return { url, title: tab?.title ?? "", saveable: isSaveableUrl(url) };
}

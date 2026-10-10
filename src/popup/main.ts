import { ready } from "knowtarium/clip";

import { createRuntime } from "../lib/runtime";
import { readCurrentPage } from "../lib/tab";
import { mountPopup } from "./view";

const { clipper, store, environment } = createRuntime();

mountPopup(document, {
  clipper,
  store,
  apiOrigin: environment.apiOrigin,
  ready,
  readPage: readCurrentPage,
  openPairing: async () => {
    // the popup closes when it loses focus, so the waiting and polling live in pair.html
    await chrome.tabs.create({ url: chrome.runtime.getURL("pair.html") });
    window.close();
  },
  close: () => {
    window.close();
  },
});

import { ready } from "knowtarium/clip";

import { createPairLaunch } from "../lib/pair-launch";
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
    // the popup closes when it loses focus, so the waiting and polling live in pair.html, which
    // starts only with this one-time nonce
    const path = await createPairLaunch(chrome.storage.session);
    await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
    window.close();
  },
  close: () => {
    window.close();
  },
  mac: navigator.userAgent.includes("Mac"),
});

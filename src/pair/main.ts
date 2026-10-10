import { createRuntime } from "../lib/runtime";
import { mountPairPage } from "./view";

const { api, store, lock, environment } = createRuntime();

const page = mountPairPage(document, {
  api,
  store,
  lock,
  apiOrigin: environment.apiOrigin,
  appOrigin: environment.appOrigin,
  extensionVersion: chrome.runtime.getManifest().version,
  openTab: async (url) => {
    await chrome.tabs.create({ url });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  shortcut: async () => {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === "_execute_action")?.shortcut ?? "";
  },
});

void page.run();

import { ready } from "knowtarium/clip";

import { createRuntime } from "./lib/runtime";

// The service worker has one job: without the `alarms` permission, the send queue goes out when
// the popup opens and when the browser starts. The listener is registered at the top level, as a
// Manifest V3 worker needs.

chrome.runtime.onStartup.addListener(() => {
  void sendQueue();
});

async function sendQueue(): Promise<void> {
  const { clipper } = createRuntime();
  if ((await clipper.waiting()) === 0) return;
  // libsodium is needed only to seal a clip again after a stale inbox key
  await ready();
  await clipper.flush();
}

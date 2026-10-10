import type { Clipper } from "./clipper";

// The service worker's one job: without the `alarms` permission, the send queue goes out when the
// popup opens and when the browser starts. The listener has to be registered at the worker's top
// level, as Manifest V3 needs; the work itself is here so it can be tested.

export interface StartupEvent {
  addListener(listener: () => void): void;
}

/** Sends the queue when there is one; libsodium loads only then (to seal again if needed). */
export async function sendQueueOnStartup(
  clipper: Clipper,
  ready: () => Promise<void>,
): Promise<void> {
  if ((await clipper.waiting()) === 0) return;
  await ready();
  await clipper.flush();
}

/** Registers the startup listener; returns the promise of the run it starts, for tests. */
export function registerStartup(
  event: StartupEvent,
  clipper: () => Clipper,
  ready: () => Promise<void>,
  onRun: (run: Promise<void>) => void = () => undefined,
): void {
  event.addListener(() => {
    const run = sendQueueOnStartup(clipper(), ready).catch(() => undefined);
    onRun(run);
  });
}

import { describe, expect, it, vi } from "vitest";

import { registerStartup } from "../src/lib/startup";
import { connected, PAGE } from "./helpers/connected";
import { readyAll } from "./helpers/owner";

describe("the service worker at browser start", () => {
  it("sends the queue when the browser starts", async () => {
    await readyAll();
    const state = connected();
    state.api.offline = true;
    await state.clipper.save({ ...PAGE, note: "", category: "" });
    state.api.offline = false;

    let listener: (() => void) | undefined;
    const runs: Promise<void>[] = [];
    const ready = vi.fn(() => Promise.resolve());
    registerStartup(
      { addListener: (l) => (listener = l) },
      () => state.clipper,
      ready,
      (run) => runs.push(run),
    );
    expect(listener).toBeTypeOf("function");
    listener?.();
    await Promise.all(runs);
    expect(ready).toHaveBeenCalledOnce();
    expect(state.api.clips.size).toBe(1);
    expect(await state.clipper.waiting()).toBe(0);
  });

  it("loads nothing and sends nothing when the queue is empty", async () => {
    const state = connected();
    let listener: (() => void) | undefined;
    const runs: Promise<void>[] = [];
    const ready = vi.fn(() => Promise.resolve());
    registerStartup(
      { addListener: (l) => (listener = l) },
      () => state.clipper,
      ready,
      (run) => runs.push(run),
    );
    listener?.();
    await Promise.all(runs);
    expect(ready).not.toHaveBeenCalled();
    expect(state.api.requests).toHaveLength(0);
  });
});

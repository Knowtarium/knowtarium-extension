import { describe, expect, it } from "vitest";

import { consumePairLaunch, createPairLaunch, memorySession } from "../src/lib/pair-launch";

describe("starting pair.html", () => {
  it("runs once for the popup's nonce", async () => {
    const session = memorySession();
    const path = await createPairLaunch(session);
    const nonce = new URLSearchParams(path.split("?")[1]).get("start");
    expect(path.startsWith("pair.html?start=")).toBe(true);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await consumePairLaunch(session, nonce)).toBe(true);
    // a reload, or a tab the browser restores, finds it used
    expect(await consumePairLaunch(session, nonce)).toBe(false);
  });

  it("refuses no nonce, a guessed one, and one after the session was cleared", async () => {
    const session = memorySession();
    expect(await consumePairLaunch(session, null)).toBe(false);
    await createPairLaunch(session);
    expect(await consumePairLaunch(session, "guessed")).toBe(false);
    const path = await createPairLaunch(session);
    const nonce = new URLSearchParams(path.split("?")[1]).get("start");
    // the browser restarted: session storage is empty
    const fresh = memorySession();
    expect(await consumePairLaunch(fresh, nonce)).toBe(false);
  });
});

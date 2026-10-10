// pair.html starts pairing only when the popup's Connect button opened it: the popup puts a
// one-time nonce in chrome.storage.session (cleared when the browser closes) and passes it in
// the page's address; the page consumes it. A tab the browser restores, a reload or a bookmark
// finds no nonce and only shows the current state, so no request starts and no web app tab
// opens by itself.

export const PAIR_NONCE_KEY = "pairNonce";

/** The part of chrome.storage.session the launch uses, so tests can keep it in memory. */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Stores a new nonce and returns pair.html's path with it. */
export async function createPairLaunch(session: SessionArea): Promise<string> {
  const value = nonce();
  await session.set({ [PAIR_NONCE_KEY]: value });
  return `pair.html?start=${value}`;
}

/** Whether `given` is the stored nonce; it can be used once either way. */
export async function consumePairLaunch(
  session: SessionArea,
  given: string | null,
): Promise<boolean> {
  const stored = (await session.get(PAIR_NONCE_KEY))[PAIR_NONCE_KEY];
  await session.remove(PAIR_NONCE_KEY);
  return given !== null && given !== "" && typeof stored === "string" && stored === given;
}

/** A session area in memory, for tests. */
export function memorySession(): SessionArea & { readonly data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (values) => {
      Object.assign(data, values);
      return Promise.resolve();
    },
    remove: (key) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete data[key];
      return Promise.resolve();
    },
  };
}

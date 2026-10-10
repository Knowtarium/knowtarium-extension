// The popup and the service worker can both send the queue (the popup when it opens, the worker when
// the browser starts). They take turns through a Web Lock, which every extension page and the worker
// share; a retry would only be answered `duplicate`, but taking turns keeps the stored queue whole.

export type Lock = <T>(run: () => Promise<T>) => Promise<T>;

const LOCK_NAME = "knowtarium-clip-queue";

interface LockManagerLike {
  request<T>(name: string, run: () => Promise<T>): Promise<T>;
}

/** The queue's lock: a Web Lock where there is one, else a chain within this page. */
export function queueLock(): Lock {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  if (locks !== undefined) return (run) => locks.request(LOCK_NAME, run);
  return localLock();
}

/** A lock that serializes calls within one page. */
export function localLock(): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}

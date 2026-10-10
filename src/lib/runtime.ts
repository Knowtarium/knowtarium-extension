import { createApi } from "./api";
import { createClipper } from "./clipper";
import { environment } from "./environment";
import { queueLock } from "./lock";
import { chromeStore } from "./storage";

/** The API, storage, lock and clipper of an extension page or the service worker. */
export function createRuntime() {
  const api = createApi(environment.apiOrigin);
  const store = chromeStore();
  const lock = queueLock();
  const clipper = createClipper({
    api,
    store,
    lock,
    apiOrigin: environment.apiOrigin,
    now: () => Date.now(),
  });
  return { api, store, lock, clipper, environment };
}

import { ready } from "knowtarium/clip";

import { createRuntime } from "./lib/runtime";
import { registerStartup } from "./lib/startup";

// the queue goes out when the browser starts (and when the popup opens)
registerStartup(chrome.runtime.onStartup, () => createRuntime().clipper, ready);

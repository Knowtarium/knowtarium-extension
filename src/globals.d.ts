import type { Environment } from "./environments";

declare global {
  /** The build's environment, baked in by vite.config.ts (`define`). */
  const __KNOWTARIUM_ENVIRONMENT__: Environment;
}

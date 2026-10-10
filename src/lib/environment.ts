import type { Environment } from "../environments";

/** The environment this build talks to (development, staging or production). */
export const environment: Environment = __KNOWTARIUM_ENVIRONMENT__;
